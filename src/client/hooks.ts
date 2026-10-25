import {
  createFunctionHandle,
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
