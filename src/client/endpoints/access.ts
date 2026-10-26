// Shared context and ownership checks for the public endpoints.
//
// `createEndpointContext` indexes every registered agent once; `rootAgent`
// resolves a public root for `open`. `threadScope` loads one assignment and
// `ownedScope` enforces ownership and the persisted root/child role. Ordinary
// endpoints use `ownedThread` to run host policy between those checks; `send`
// resolves the caller's receipt first so policy receives accurate replay facts.

import type { GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { ComponentApi } from "../../component/_generated/component.js";
import { assertFact } from "../../component/facts.js";
import type { SettingsSnapshot } from "../../component/run-settings.js";
import { resolveLimits, type Limits } from "../../component/limits.js";
import type { AgentEvent, ManagedAgent, Registration } from "../types.js";

/** What every endpoint builder needs, resolved once per `authorizedEndpoints` call. */
export type EndpointContext = {
  component: ComponentApi;
  config: Registration;
  limits: Limits;
  settings: SettingsSnapshot;
  /** Every agent in the registered graph, by name: roots, children and side agents. */
  managedAgents: Map<string, ManagedAgent>;
};

/** The operations `ownedThread` authorizes; each is the host policy's `operation`. */
export type ThreadOperation =
  | "title"
  | "rename"
  | "summary"
  | "summarize"
  | "send"
  | "respond"
  | "answer"
  | "cancel"
  | "messages"
  | "streams"
  | "activity";

/**
 * Resolve the endpoint context.
 *
 * A managed conversation is always a native thread, including a delegated
 * conversation. Index the entire registered graph so a persisted assignment's
 * agent name resolves to the correct native component for transcript reads.
 * Walk recursively rather than baking today's delegation-depth limit into the
 * reader, and visit shared agents once. Registration validates name uniqueness
 * and graph shape before these endpoints are constructed.
 */
export function createEndpointContext(
  component: ComponentApi,
  config: Registration,
  settings: SettingsSnapshot,
): EndpointContext {
  const limits = resolveLimits(config.limits);
  const managedAgents = new Map<string, ManagedAgent>();

  function include(managed: ManagedAgent) {
    if (managedAgents.has(managed.name)) return;

    managedAgents.set(managed.name, managed);

    for (const child of managed.subagents) include(child);

    for (const side of managed.sideAgents ?? []) include(side.agent);
  }

  for (const root of config.agents) include(root);

  return { component, config, limits, managedAgents, settings };
}

/**
 * Resolve a public root agent by name, or throw `UNKNOWN_AGENT`.
 *
 * Opening a new public conversation still resolves roots only. Merely being
 * readable through an owned child thread must not expose a child as a root.
 */
export function rootAgent(ep: EndpointContext, name: string) {
  const found = ep.config.agents.find((a) => a.name === name);

  if (!found) throw new Error("UNKNOWN_AGENT");

  return found;
}

/**
 * Load one bounded assignment projection, without granting access. Request
 * endpoints need its agent before resolving replay; every caller must still
 * authorize and pass `ownedScope` before returning data or saving messages.
 */
export async function threadScope(
  ep: EndpointContext,
  ctx: GenericQueryCtx<GenericDataModel>,
  threadId: string,
) {
  assertFact(threadId, "threadId");
  const row = await ctx.runQuery(ep.component.turns.send.assignment, { threadId });

  if (!row) throw new Error("FORBIDDEN");

  return row;
}

/** Enforce ownership and the persisted root/child role after host authorization. */
export function ownedScope(
  ep: EndpointContext,
  row: Awaited<ReturnType<typeof threadScope>>,
  subject: string,
  operation: ThreadOperation,
) {
  assertFact(subject, "subject");

  if (subject !== row.subject) throw new Error("FORBIDDEN");

  // Ownership permits reading a child's transcript and resolving its recorded
  // approvals. Child turns belong to the coordinator's bounded delegation and
  // settlement path; accepting a public send could start another child turn
  // outside that path. Keep send and coordination reads (activity/delegations)
  // root-only; messages/respond use the same ownership check for every thread.
  // The role must come from the persisted assignment, not today's root names:
  // a later deployment can register a former child agent as a root without
  // changing the role of any existing child thread. A name-based check would
  // grant send/activity access to those old threads (and previously also let
  // a shared Agent object registered as both root and child bypass the guard).
  if (
    operation !== "messages" &&
    operation !== "streams" &&
    operation !== "respond" &&
    operation !== "answer" &&
    row.root === false
  )
    throw new Error("FORBIDDEN");

  const native = ep.managedAgents.get(row.agent);

  if (!native) throw new Error("UNKNOWN_AGENT");

  return { ...row, native };
}

/** Authorize ordinary thread operations; request endpoints resolve replay first. */
export async function ownedThread(
  ep: EndpointContext,
  ctx: GenericQueryCtx<GenericDataModel>,
  threadId: string,
  operation: Exclude<ThreadOperation, "send">,
) {
  const row = await threadScope(ep, ctx, threadId);
  const trusted = await ep.config.authorize(ctx, { operation, agent: row.agent, threadId });

  return ownedScope(ep, row, trusted.subject, operation);
}

/** Report one lifecycle event to the host; never changes the request outcome. */
export async function observe(
  ep: EndpointContext,
  ctx: GenericMutationCtx<GenericDataModel>,
  event: AgentEvent,
) {
  try {
    await ep.config.observe?.(ctx, event);
  } catch {
    // Observability is best effort and must never change the request outcome.
  }
}
