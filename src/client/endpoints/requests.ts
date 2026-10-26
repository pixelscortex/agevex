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
import {
  createFunctionHandle,
  mutationGeneric,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { v } from "convex/values";
import { assertFact } from "../../component/facts.js";
import { LIMITS } from "../../component/limits.js";
import { taskPreview } from "../../component/run_tree_values.js";
import { modelOverrides, validModelOverrides } from "../../component/models.js";
import { receipt } from "../../component/schema.js";
import { savedMessageRef } from "../native-saves.js";
import { fingerprint } from "../once.js";
import { persistedTextConfig } from "../text/options.js";
import type { AuthorizationScope, ManagedAgent } from "../types.js";
import { observe, ownedScope, rootAgent, threadScope, type EndpointContext } from "./access.js";
import { attachment, recordAttachments, validateFiles } from "./attachments.js";

type SavedMessage = Awaited<ReturnType<typeof saveMessage>>;

/** A non-empty bounded message and a bounded request key; else the rejection code. */
function validateInput(text: string, requestKey: string) {
  if (!text.trim() || text.length > LIMITS.messageLength) return "INVALID_MESSAGE" as const;

  if (!requestKey || requestKey.length > LIMITS.requestKeyLength)
    return "INVALID_REQUEST_KEY" as const;
}

/**
 * Per-agent model overrides must be well formed, name only agents reachable from
 * this root through delegation, and use only allowlisted model ids.
 */
function validModels(
  ep: EndpointContext,
  models: Record<string, string> | undefined,
  root: ManagedAgent,
) {
  if (models === undefined) return true;

  const reachable = new Set<string>();

  function visit(agent: ManagedAgent) {
    if (reachable.has(agent.name)) return;

    reachable.add(agent.name);

    for (const child of agent.subagents) visit(child);
  }
  visit(root);

  return (
    validModelOverrides(models) &&
    Object.entries(models).every(
      ([name, id]) => reachable.has(name) && ep.config.modelAllowlist?.includes(id),
    )
  );
}

type RequestScope = Extract<AuthorizationScope, { operation: "open" | "send" }>;
type RequestInput = {
  text: string;
  models?: Record<string, string>;
  files?: string[];
};

/** Bound every fingerprint input before hashing, after host authorization. */
async function prepareRequest(
  ep: EndpointContext,
  scope: RequestScope,
  input: RequestInput,
  managed?: ManagedAgent,
) {
  assertFact(scope.agent, "agent");
  const invalid = validateInput(input.text, scope.requestKey);

  if (invalid) return { rejected: { status: "rejected" as const, code: invalid } };

  if (!managed && !ep.config.agents.some((agent) => agent.name === scope.agent))
    return { rejected: { status: "rejected" as const, code: "UNKNOWN_AGENT" as const } };

  const native = managed ?? rootAgent(ep, scope.agent);

  if (!validModels(ep, input.models, native))
    return { rejected: { status: "rejected" as const, code: "INVALID_MODELS" as const } };

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
async function authorizeRequest(
  ep: EndpointContext,
  ctx: GenericMutationCtx<GenericDataModel>,
  scope: RequestScope,
) {
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
function lookupRequest(
  ep: EndpointContext,
  ctx: GenericMutationCtx<GenericDataModel>,
  subject: string,
  scope: RequestScope,
  hash: string,
) {
  return ctx.runQuery(ep.component.turns.send.lookupReceipt, {
    subject,
    requestKey: scope.requestKey,
    fingerprint: hash,
  });
}

/** One admitted request, as `acceptRequest` passes it to `turns.send.accept`. */
type AcceptedRequest = {
  operation: "open" | "send";
  subject: string;
  agent: string;
  native: ManagedAgent;
  threadId: string;
  requestKey: string;
  fingerprint: string;
  saved: SavedMessage;
  runTurn: string;
  models: Record<string, string> | undefined;
};

/**
 * Admit a saved prompt into the queue and report it. Throws
 * `ADMISSION_CHANGED` if admission refuses a request this transaction already
 * checked (it cannot change within one transaction, so this is an invariant).
 */
async function acceptRequest(
  ep: EndpointContext,
  ctx: GenericMutationCtx<GenericDataModel>,
  request: AcceptedRequest,
) {
  const { messageId, message } = request.saved;

  const accepted = await ctx.runMutation(ep.component.turns.send.accept, {
    subject: request.subject,
    agent: request.agent,
    threadId: request.threadId,
    requestKey: request.requestKey,
    fingerprint: request.fingerprint,
    promptMessageId: messageId,
    task: taskPreview(message.text ?? ""),
    trackContext:
      !!request.native.sideAgents?.length || ep.config.title !== false || !!ep.config.summary,
    textConfig: await persistedTextConfig(ep.config, request.native),
    savedMessage: savedMessageRef(messageId, message),
    runTurn: request.runTurn,
    limits: ep.limits,
    models: request.models,
    settings: ep.settings,
  });

  if (accepted.status !== "accepted") throw new Error("ADMISSION_CHANGED");

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
export function openEndpoint(ep: EndpointContext) {
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
      const scope = { operation: "open" as const, agent: args.agent, requestKey: args.requestKey };

      const subject = await authorizeRequest(ep, ctx, scope);
      const prepared = await prepareRequest(ep, scope, { text: prompt, models, files });

      if (prepared.rejected) return prepared.rejected;

      const { native, hash } = prepared;
      const duplicate = await lookupRequest(ep, ctx, subject, scope, hash);

      if (duplicate) return duplicate;

      const attached = await attachment(ep, ctx, native, subject, prompt, files);

      if ("rejected" in attached)
        return { status: "rejected" as const, code: "ATTACHMENT_LIMIT" as const };

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
export function sendEndpoint(ep: EndpointContext) {
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
        operation: "send" as const,
        agent: stored.agent,
        threadId,
        requestKey: args.requestKey,
      };

      const subject = await authorizeRequest(ep, ctx, scope);
      const row = ownedScope(ep, stored, subject, "send");
      const prepared = await prepareRequest(ep, scope, { text, models, files }, row.native);

      if (prepared.rejected) return prepared.rejected;

      const { hash } = prepared;
      const duplicate = await lookupRequest(ep, ctx, subject, scope, hash);

      if (duplicate) return duplicate;

      const refusal = await ctx.runQuery(ep.component.turns.send.admission, {
        threadId,
        subject: row.subject,
      });

      if (refusal) return refusal;

      const attached = await attachment(ep, ctx, row.native, row.subject, text, files);

      if ("rejected" in attached)
        return { status: "rejected" as const, code: "ATTACHMENT_LIMIT" as const };

      await ep.config.admit?.(ctx, { ...scope, subject });

      const saved = await saveMessage(ctx, row.native.component, {
        threadId,
        message: attached.message,
        metadata: attached.metadata,
        userId: row.subject,
      });

      await recordAttachments(
        ep,
        ctx,
        attached.native,
        files,
        row.subject,
        threadId,
        saved.messageId,
      );

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
