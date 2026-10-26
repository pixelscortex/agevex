/**
 * The exact-message reference ring on `assignments.contextMessages`.
 *
 * Watched assignments (those a side review reads) record the identity, order
 * and size of every successful user/assistant message in the same transaction
 * that saves it natively, so a review can later read exactly those documents
 * without listing the transcript. Writers: turns.slices.write (model saves),
 * turns.send.accept / subagents.launch.attach (prompts), hooks.reviews.capture (host coordinator
 * saves) and hooks/notes.ts (notes). Readers: `reviewWindow`
 * (`hooks.reviews.reviewContext`), with `markReviewed` (`hooks.reviews.reviewed`) recording
 * each side reviewer's consumed boundary.
 */
import { type Infer } from "convex/values";
import type { MessageDoc } from "@convex-dev/agent";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** One recorded native message: id, native order/stepOrder and stored size. */
export declare const messageRef: import("convex/values").VObject<{
    order: number;
    bytes: number;
    id: string;
    stepOrder: number;
}, {
    id: import("convex/values").VString<string, "required">;
    order: import("convex/values").VFloat64<number, "required">;
    stepOrder: import("convex/values").VFloat64<number, "required">;
    bytes: import("convex/values").VFloat64<number, "required">;
}, "required", "order" | "bytes" | "id" | "stepOrder">;
/** The newest ref always carries the highest sequence: every push takes
 * ++sequence, the list is sorted by it, and the bounded ring keeps the tail.
 * Hence no separate counter is stored; 0 means nothing was ever recorded. */
export declare function latestSequence(refs: {
    sequence: number;
}[] | undefined): number;
/** Append refs to the ring (re-saving an id moves it to the tail) and keep
 * only the newest `LIMITS.contextMessages`. A no-op for unwatched rows. */
export declare function recordRefs(ctx: MutationCtx, row: Doc<"assignments">, messages: Infer<typeof messageRef>[]): Promise<void>;
/** Record exact native identities in the creating transaction. The ring contains
 * no copied request/tool content. Native addMessages already returns these docs
 * (Agent 0.7.7 src/client/messages.ts:132-155), so this costs no transcript read.
 * <=24 references *160 bytes <4 KiB per assignment. Side snapshot admission sums
 * recorded document sizes before exact-id reads: <=2 MiB, output <=48 KiB.
 */
export declare function recordMessages(ctx: MutationCtx, row: Doc<"assignments">, messages: MessageDoc[]): Promise<void>;
/** The message refs a side reviewer should read now, or null when the turn
 * is stale or its cadence (every `turns` completed turns or `minutes`) is not
 * yet due. Takes the newest refs since the reviewer's last boundary within
 * `LIMITS.contextReadBytes`, in native order, plus the new boundary. */
export declare function reviewWindow(ctx: QueryCtx, args: {
    assignmentId: Id<"assignments">;
    executionId: string;
    agent: string;
    turns?: number;
    minutes?: number;
}): Promise<{
    refs: {
        order: number;
        bytes: number;
        id: string;
        stepOrder: number;
        sequence: number;
    }[];
    boundary: number;
} | null>;
/** Record that a side reviewer consumed the ring up to `boundary` at this
 * turn, replacing its previous entry (at most `LIMITS.sideAgents` reviewers). */
export declare function markReviewed(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    executionId: string;
    agent: string;
    boundary: number;
}): Promise<null>;
