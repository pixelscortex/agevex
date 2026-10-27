// The two public endpoints that start work: `open` (new conversation) and `send`
// (next message in an owned root conversation).
//
// Both authorize first: the host owns the mapping from identity to subject.
// Validated, fingerprinted inputs resolve that subject's retained receipt before
// fresh work reaches the optional host admit hook. All returning refusals
// (including queue and attachment limits) precede admit. After it, native saves
// and turns.send.accept either accept together with host writes or throw to
// roll back the entire mutation; no non-accepting receipt can commit host writes.
import { createThread, saveMessage } from "@convex-dev/agent";
import { createFunctionHandle, mutationGeneric, } from "convex/server";
import { v } from "convex/values";
import { assertFact } from "../../component/facts.js";
import { LIMITS } from "../../component/limits.js";
import { modelOverrides, validModelOverrides } from "../../component/models.js";
import { receipt } from "../../component/schema.js";
import { fingerprint } from "../once.js";
import { persistedTextConfig } from "../text/options.js";
import { observe, ownedScope, rootAgent, threadScope } from "./access.js";
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
/** Bound every fingerprint input before hashing, after host authorization. */
async function prepareRequest(ep, scope, input, managed) {
    assertFact(scope.agent, "agent");
    const invalid = validateInput(input.text, scope.requestKey);
    if (invalid)
        return { rejected: { status: "rejected", code: invalid } };
    if (!managed && !ep.config.agents.some((agent) => agent.name === scope.agent))
        return { rejected: { status: "rejected", code: "UNKNOWN_AGENT" } };
    const native = managed ?? rootAgent(ep, scope.agent);
    if (!validModels(ep, input.models, native))
        return { rejected: { status: "rejected", code: "INVALID_MODELS" } };
    validateFiles(input.files);
    const hash = await fingerprint([
        scope.operation,
        scope.operation === "open" ? scope.agent : scope.threadId,
        input.text,
        input.models ?? null,
        input.files ?? [],
    ]);
    return { native, hash };
}
/**
 * Authorize every call before validation or receipt lookup. Only the host's
 * returned subject is trusted; it may differ from ctx.auth's identity subject.
 */
async function authorizeRequest(ep, ctx, scope) {
    const { subject } = await ep.config.authorize(ctx, scope);
    assertFact(subject, "subject");
    return subject;
}
/**
 * One exact authorized subject/key lookup uses unique() (Convex implements it
 * with take(2)): <=2 * 1 MiB even for corrupt duplicate ledger rows, independent
 * of queue or receipt counts. Never substitute a thread's owner for the host's
 * authorized subject: foreign callers must not learn another subject's keys.
 */
function lookupRequest(ep, ctx, subject, scope, hash) {
    return ctx.runQuery(ep.component.turns.send.lookupReceipt, {
        subject,
        requestKey: scope.requestKey,
        fingerprint: hash,
    });
}
/**
 * Admit a saved prompt into the queue and report it. Throws
 * `ADMISSION_CHANGED` if admission refuses a request this transaction already
 * checked (it cannot change within one transaction, so this is an invariant).
 */
async function acceptRequest(ep, ctx, request) {
    const { messageId } = request.saved;
    const accepted = await ctx.runMutation(ep.component.turns.send.accept, {
        subject: request.subject,
        agent: request.agent,
        threadId: request.threadId,
        requestKey: request.requestKey,
        fingerprint: request.fingerprint,
        promptMessageId: messageId,
        textConfig: await persistedTextConfig(ep.config, request.native),
        runTurn: request.runTurn,
        limits: ep.limits,
        models: request.models,
        settings: ep.settings,
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
            const { prompt, models, files } = args;
            const scope = { operation: "open", agent: args.agent, requestKey: args.requestKey };
            const subject = await authorizeRequest(ep, ctx, scope);
            const prepared = await prepareRequest(ep, scope, { text: prompt, models, files });
            if (prepared.rejected)
                return prepared.rejected;
            const { native, hash } = prepared;
            const duplicate = await lookupRequest(ep, ctx, subject, scope, hash);
            if (duplicate)
                return duplicate;
            const attached = await attachment(ep, ctx, native, subject, prompt, files);
            if ("rejected" in attached)
                return { status: "rejected", code: "ATTACHMENT_LIMIT" };
            await ep.config.admit?.(ctx, { ...scope, subject });
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
            const { threadId, text, models, files } = args;
            const stored = await threadScope(ep, ctx, threadId);
            const scope = {
                operation: "send",
                agent: stored.agent,
                threadId,
                requestKey: args.requestKey,
            };
            const subject = await authorizeRequest(ep, ctx, scope);
            const row = ownedScope(ep, stored, subject, "send");
            const prepared = await prepareRequest(ep, scope, { text, models, files }, row.native);
            if (prepared.rejected)
                return prepared.rejected;
            const { hash } = prepared;
            const duplicate = await lookupRequest(ep, ctx, subject, scope, hash);
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
            await ep.config.admit?.(ctx, { ...scope, subject });
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
