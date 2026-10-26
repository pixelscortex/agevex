// The two public endpoints that start work: `open` (new conversation) and `send`
// (next message in an owned root conversation).
//
// Both are idempotent per subject and request key: input is validated and
// fingerprinted, a duplicate returns its stored receipt (`turns.send.lookupReceipt`),
// and only a fresh request saves the native prompt (with its attachments) and is
// admitted by `turns.send.accept` in the same transaction. `send` also respects the
// thread's admission state (`turns.send.admission`) before any native write.
import { createThread, saveMessage } from "@convex-dev/agent";
import { createFunctionHandle, mutationGeneric, } from "convex/server";
import { v } from "convex/values";
import { assertFact } from "../../component/facts.js";
import { LIMITS } from "../../component/limits.js";
import { modelOverrides, validModelOverrides } from "../../component/models.js";
import { receipt } from "../../component/schema.js";
import { savedMessageRef } from "../native-saves.js";
import { fingerprint } from "../once.js";
import { observe, ownedThread, rootAgent } from "./access.js";
import { attachment, recordAttachments, validateFiles } from "./attachments.js";
/** A non-empty bounded message and a bounded request key; else the rejection code. */
function validateInput(text, requestKey) {
    if (!text.trim() || text.length > LIMITS.messageLength)
        return "INVALID_MESSAGE";
    if (!requestKey || requestKey.length > LIMITS.requestKeyLength)
        return "INVALID_REQUEST_KEY";
}
/**
 * Per-agent model overrides must be well formed, name only agents reachable from
 * this root through delegation, and use only allowlisted model ids.
 */
function validModels(ep, models, root) {
    if (models === undefined)
        return true;
    const reachable = new Set();
    function visit(agent) {
        if (reachable.has(agent.name))
            return;
        reachable.add(agent.name);
        for (const child of agent.subagents)
            visit(child);
    }
    visit(root);
    return (validModelOverrides(models) &&
        Object.entries(models).every(([name, id]) => reachable.has(name) && ep.config.modelAllowlist?.includes(id)));
}
/**
 * Admit a saved prompt into the queue and report it. Throws
 * `ADMISSION_CHANGED` if admission refuses a request this transaction already
 * checked (it cannot change within one transaction, so this is an invariant).
 */
async function acceptRequest(ep, ctx, request) {
    const { messageId, message } = request.saved;
    const accepted = await ctx.runMutation(ep.component.turns.send.accept, {
        subject: request.subject,
        agent: request.agent,
        threadId: request.threadId,
        requestKey: request.requestKey,
        fingerprint: request.fingerprint,
        promptMessageId: messageId,
        trackContext: !!request.native.sideAgents?.length,
        savedMessage: savedMessageRef(messageId, message),
        runTurn: request.runTurn,
        limits: ep.limits,
        models: request.models,
    });
    if (accepted.status !== "accepted")
        throw new Error("ADMISSION_CHANGED");
    await observe(ep, ctx, {
        type: "request.accepted",
        operation: request.operation,
        assignmentId: accepted.assignmentId,
        threadId: accepted.threadId,
        agent: request.agent,
    });
    return accepted;
}
/** `open`: start a new conversation with a public root agent. */
export function openEndpoint(ep) {
    return mutationGeneric({
        args: {
            agent: v.string(),
            prompt: v.string(),
            requestKey: v.string(),
            models: v.optional(modelOverrides),
            files: v.optional(v.array(v.string())),
        },
        returns: receipt,
        handler: async (ctx, args) => {
            const { subject } = await ep.config.authorize(ctx, { operation: "open", agent: args.agent });
            assertFact(subject, "subject");
            assertFact(args.agent, "agent");
            const invalid = validateInput(args.prompt, args.requestKey);
            if (invalid)
                return { status: "rejected", code: invalid };
            if (!ep.config.agents.some((a) => a.name === args.agent))
                return { status: "rejected", code: "UNKNOWN_AGENT" };
            const native = rootAgent(ep, args.agent);
            if (!validModels(ep, args.models, native))
                return { status: "rejected", code: "INVALID_MODELS" };
            validateFiles(args.files);
            const { prompt, models, files } = args;
            const hash = await fingerprint(["open", args.agent, prompt, models ?? null, files ?? []]);
            const duplicate = await ctx.runQuery(ep.component.turns.send.lookupReceipt, {
                subject,
                requestKey: args.requestKey,
                fingerprint: hash,
            });
            if (duplicate)
                return duplicate;
            const attached = await attachment(ep, ctx, native, subject, prompt, files);
            if ("rejected" in attached)
                return { status: "rejected", code: "ATTACHMENT_LIMIT" };
            const runTurn = await createFunctionHandle(ep.config.refs.runTurn());
            const threadId = await createThread(ctx, native.component, { userId: subject });
            const saved = await saveMessage(ctx, native.component, {
                threadId,
                message: attached.message,
                metadata: attached.metadata,
                // Reserve order zero for notes posted before the first turn claim.
                order: LIMITS.firstPromptOrder,
                userId: subject,
            });
            await recordAttachments(ep, ctx, attached.native, files, subject, threadId, saved.messageId);
            const request = { subject, agent: args.agent, native, threadId, models };
            return acceptRequest(ep, ctx, {
                ...request,
                operation: "open",
                requestKey: args.requestKey,
                fingerprint: hash,
                saved,
                runTurn,
            });
        },
    });
}
/** `send`: the next user message in an owned root conversation. */
export function sendEndpoint(ep) {
    return mutationGeneric({
        args: {
            threadId: v.string(),
            text: v.string(),
            requestKey: v.string(),
            models: v.optional(modelOverrides),
            files: v.optional(v.array(v.string())),
        },
        returns: receipt,
        handler: async (ctx, args) => {
            const row = await ownedThread(ep, ctx, args.threadId, "send");
            const invalid = validateInput(args.text, args.requestKey);
            if (invalid)
                return { status: "rejected", code: invalid };
            if (!validModels(ep, args.models, row.native))
                return { status: "rejected", code: "INVALID_MODELS" };
            validateFiles(args.files);
            const { threadId, text, models, files } = args;
            const hash = await fingerprint(["send", threadId, text, models ?? null, files ?? []]);
            const duplicate = await ctx.runQuery(ep.component.turns.send.lookupReceipt, {
                subject: row.subject,
                requestKey: args.requestKey,
                fingerprint: hash,
            });
            if (duplicate)
                return duplicate;
            const refusal = await ctx.runQuery(ep.component.turns.send.admission, {
                threadId,
                subject: row.subject,
            });
            if (refusal)
                return refusal;
            const attached = await attachment(ep, ctx, row.native, row.subject, text, files);
            if ("rejected" in attached)
                return { status: "rejected", code: "ATTACHMENT_LIMIT" };
            const saved = await saveMessage(ctx, row.native.component, {
                threadId,
                message: attached.message,
                metadata: attached.metadata,
                userId: row.subject,
            });
            await recordAttachments(ep, ctx, attached.native, files, row.subject, threadId, saved.messageId);
            const runTurn = await createFunctionHandle(ep.config.refs.runTurn());
            const request = {
                subject: row.subject,
                agent: row.agent,
                native: row.native,
                threadId,
                models,
            };
            return acceptRequest(ep, ctx, {
                ...request,
                operation: "send",
                requestKey: args.requestKey,
                fingerprint: hash,
                saved,
                runTurn,
            });
        },
    });
}
