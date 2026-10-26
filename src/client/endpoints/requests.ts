// The two public endpoints that start work: `open` (new conversation) and `send`
// (next message in an owned root conversation).
//
// Both are idempotent per subject and request key: input is validated and
// fingerprinted, then the caller's receipt is resolved before host authorization.
// Every call supplies requestKey/replay to that policy; an authorized duplicate
// returns its stored receipt (`turns.send.lookupReceipt`),
// and only a fresh request saves the native prompt (with its attachments) and is
// admitted by `turns.send.accept` in the same transaction. `send` also respects the
// thread's admission state (`turns.send.admission`) before any native write.

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
import { modelOverrides, validModelOverrides } from "../../component/models.js";
import { receipt } from "../../component/schema.js";
import { savedMessageRef } from "../native-saves.js";
import { fingerprint } from "../once.js";
import { persistedTextConfig } from "../text/options.js";
import type { AuthorizationScope, ManagedAgent, Receipt } from "../types.js";
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

type RequestScope =
  | Omit<Extract<AuthorizationScope, { operation: "open" }>, "replay">
  | Omit<Extract<AuthorizationScope, { operation: "send" }>, "replay">;
type RequestInput = {
  text: string;
  models?: Record<string, string>;
  files?: string[];
};

/** Bound every fingerprint input before hashing; defer refusals until authorization. */
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
 * Resolve replay in the acceptance transaction before host policy. Never use a
 * thread's stored owner as the lookup principal: a foreign caller could learn
 * that owner's key through replay metadata. One exact subject/key lookup uses
 * unique() (Convex implements it with take(2)): <=2 * 1 MiB even if duplicate
 * ledger rows are corrupt, independent of queue or receipt counts.
 * Deferred failures preserve authorization even when input validation throws.
 */
async function authorizeRequest(
  ep: EndpointContext,
  ctx: GenericMutationCtx<GenericDataModel>,
  scope: RequestScope,
  prepare: () => ReturnType<typeof prepareRequest>,
) {
  const identity = await ctx.auth.getUserIdentity();
  const subject = identity?.subject;
  let duplicate: Receipt | null = null;
  let prepared!: Awaited<ReturnType<typeof prepareRequest>>;
  let failure: { cause: unknown } | undefined;

  try {
    prepared = await prepare();

    if (subject && prepared.hash) {
      assertFact(subject, "subject");

      duplicate = await ctx.runQuery(ep.component.turns.send.lookupReceipt, {
        subject,
        requestKey: scope.requestKey,
        fingerprint: prepared.hash,
      });
    }
  } catch (cause) {
    failure = { cause };
  }

  const trusted = await ep.config.authorize(ctx, {
    ...scope,
    replay: duplicate?.status === "duplicate",
  });

  assertFact(trusted.subject, "subject");

  if (!subject || trusted.subject !== subject) throw new Error("FORBIDDEN");

  if (failure) throw failure.cause;

  return { subject, prepared, duplicate };
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

      const { subject, prepared, duplicate } = await authorizeRequest(ep, ctx, scope, () =>
        prepareRequest(ep, scope, { text: prompt, models, files }),
      );

      if (prepared.rejected) return prepared.rejected;

      if (duplicate) return duplicate;

      const { native, hash } = prepared;
      const attached = await attachment(ep, ctx, native, subject, prompt, files);

      if ("rejected" in attached)
        return { status: "rejected" as const, code: "ATTACHMENT_LIMIT" as const };

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

      const { subject, prepared, duplicate } = await authorizeRequest(ep, ctx, scope, () =>
        prepareRequest(ep, scope, { text, models, files }, ep.managedAgents.get(stored.agent)),
      );

      const row = ownedScope(ep, stored, subject, "send");

      if (prepared.rejected) return prepared.rejected;

      if (duplicate) return duplicate;

      const { hash } = prepared;

      const refusal = await ctx.runQuery(ep.component.turns.send.admission, {
        threadId,
        subject: row.subject,
      });

      if (refusal) return refusal;

      const attached = await attachment(ep, ctx, row.native, row.subject, text, files);

      if ("rejected" in attached)
        return { status: "rejected" as const, code: "ATTACHMENT_LIMIT" as const };

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
