/**
 * Notes, from admission to native history.
 *
 * Notes are short `<note from="...">` user messages posted by hooks or the
 * host. `addNote` (`queueNote`) keeps one as a passive `inbox` row (body in
 * `text`) until a safe turn claim saves it (`claimNotes`, called by
 * turns/claim.ts), placed after the prior response and before the claimed
 * work. `beforeTurnNote` (`saveBeforeTurnNote`) saves one immediately when
 * no approval results are outstanding. `cancelNotes` (`dropCancelledNotes`)
 * deletes a cancelled epoch's unsaved bodies. Touches `inbox` and
 * `assignments`.
 */
import { type Infer } from "convex/values";
import { type MutationCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
/** The native Agent handles claim needs to place notes: read the anchor, save
 * empty assistant slots, then turn each slot into the note's user message. */
export declare const noteHandles: import("convex/values").VObject<{
    getMessages: string;
    addMessages: string;
    updateMessage: string;
}, {
    getMessages: import("convex/values").VString<string, "required">;
    addMessages: import("convex/values").VString<string, "required">;
    updateMessage: import("convex/values").VString<string, "required">;
}, "required", "getMessages" | "addMessages" | "updateMessage">;
/** Called only by claim, after choosing the claimed work and before publishing
 * its running state. Posted notes never write native history anywhere else.
 * Agent 0.7.7 component/messages.ts:302-305,390-406 supports integer order,
 * but moves subsequent USER messages to a fresh order. Allocate successful
 * empty assistant slots in one batch, then finalize their user roles with
 * updateMessage (:553-597), preserving both arrival order and native positions.
 * <=24 raw rows *17 KiB read twice + six native merge heads <=6 MiB + one
 * anchor <=1 MiB +24 escaped notes *50 KiB +metadata <128 KiB: <10 MiB read,
 * <3 MiB written. The bounded ready claim uses metadata only; native heads
 * are read just once.
 */
export declare function claimNotes(ctx: MutationCtx, row: Doc<"assignments">, handles: Infer<typeof noteHandles>, order: number): Promise<void>;
/** Queue a note for the next safe claim; see `queueNote`. */
export declare const addNote: import("convex/server").RegisteredMutation<"public", {
    from: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    text: string;
}, Promise<boolean>>;
/** Save a beforeTurn note now, or queue it behind outstanding approval
 * results; see `saveBeforeTurnNote`. */
export declare const beforeTurnNote: import("convex/server").RegisteredMutation<"public", {
    from: string;
    getMessages: string;
    addMessages: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    text: string;
}, Promise<void>>;
/** Delete a cancelled epoch's unsaved note bodies; one finite job per
 * assignment, scheduled by turns.cancel.cancel. */
export declare const cancelNotes: import("convex/server").RegisteredMutation<"internal", {
    epoch: number;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<void>>;
