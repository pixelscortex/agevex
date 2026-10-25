import type { AgentComponent, MessageDoc } from "@convex-dev/agent";
import {
  createFunctionHandle,
  getFunctionAddress,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import type { ManagedAgent } from "./types.js";

export type NoteArgs = { threadId: string; text: string; from: string };

/** Mutation-only: authorization, native save, exact-id capture and passive
 * admission share one Convex transaction. A note never wakes a workflow. */
export async function postNote(
  ctx: GenericMutationCtx<GenericDataModel>,
  component: ComponentApi,
  managed: ManagedAgent,
  assignmentId: string,
  args: NoteArgs,
): Promise<boolean> {
  return ctx.runMutation(component.hooks.addNote, {
    assignmentId,
    text: args.text,
    from: args.from,
    addMessages: await createFunctionHandle(managed.component.messages.addMessages),
  });
}

/** Agent 0.7.7 exposes contextHandler (vercel/client/types.ts:307,673;
 * start.ts:194-200), but mapping.ts:142-148 strips document ids BEFORE that
 * handler. Use the supplied ActionCtx's native context-read seam to suppress
 * only our recorded ids, before conversion. search.ts:160-166,244-269 uses
 * these public functions for recent/search context. Keep document identities,
 * orders and page cursors intact: an absent message body is natively omitted
 * by docsToModelMessages. This adds no query, scan, stored marker or body copy,
 * and affects only this generation, never the public transcript reader.
 */
export function controlContext(
  ctx: GenericActionCtx<GenericDataModel>,
  component: AgentComponent,
  messageIds: string[],
): GenericActionCtx<GenericDataModel> {
  const excluded = new Set(messageIds);
  const address = (ref: Parameters<typeof ctx.runQuery>[0]) =>
    JSON.stringify(getFunctionAddress(ref));
  const recent = address(component.messages.listMessagesByThreadId);
  const search = JSON.stringify(getFunctionAddress(component.messages.searchMessages));
  const mask = (docs: MessageDoc[]) =>
    docs.map((doc) => (excluded.has(doc._id) ? { ...doc, message: undefined } : doc));
  return {
    ...ctx,
    runQuery: (async (ref, ...args) => {
      const result = await ctx.runQuery(ref, ...args);
      if (address(ref) !== recent) return result;
      return { ...result, page: mask(result.page) };
    }) as typeof ctx.runQuery,
    runAction: (async (ref, ...args) => {
      const result = await ctx.runAction(ref, ...args);
      return JSON.stringify(getFunctionAddress(ref)) === search ? mask(result) : result;
    }) as typeof ctx.runAction,
  };
}
