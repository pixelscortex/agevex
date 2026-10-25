import { type GenericDataModel, type GenericMutationCtx } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

export type NoteArgs = { threadId: string; text: string; from: string };

/** Mutation-only admission: all payloads wait for the next turn claim. */
export async function postNote(
  ctx: GenericMutationCtx<GenericDataModel>,
  component: ComponentApi,
  assignmentId: string,
  args: NoteArgs,
): Promise<boolean> {
  return ctx.runMutation(component.hooks.addNote, {
    assignmentId,
    text: args.text,
    from: args.from,
  });
}
