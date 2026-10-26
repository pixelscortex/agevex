import type { CoordinatorCtx, RuntimeContext } from "../registration/context.js";
export type NoteArgs = {
    threadId: string;
    text: string;
    from: string;
};
/**
 * Admit one note for the assignment's next turn. Mutation-only admission: all
 * payloads wait for the next turn claim, never a slice boundary between tool
 * calls. Returns false when the component refuses it (pending-note cap).
 */
export declare function postNote(ctx: CoordinatorCtx, component: RuntimeContext["component"], assignmentId: string, args: NoteArgs): Promise<boolean>;
/** A sandbox job's terminal report, delivered by the sandbox module's callback. */
export type SandboxCompletion = {
    subject: string;
    threadId: string;
    runId: string;
    jobId: string;
    state: "done" | "failed" | "unknown";
    exitCode?: number;
    logTail?: string;
};
/**
 * Post one sandbox completion as a note on the managed thread that started it.
 *
 * Throws `FORBIDDEN` unless the sandbox slot is configured, the thread is managed
 * by this registration, the stored owner matches, and the host `sandbox` policy
 * returns that same owner; throws `INVALID_SANDBOX_COMPLETION` for an
 * out-of-bounds report. Returns whether the note was admitted.
 */
export declare function sandboxComplete(rt: RuntimeContext, ctx: CoordinatorCtx, event: SandboxCompletion): Promise<boolean>;
/**
 * Host-posted note for a managed thread's next turn.
 *
 * The thread must be managed, the host `note` policy must return a subject, and
 * that subject must own the thread; otherwise `FORBIDDEN`. Returns whether the
 * note was admitted (a full pending-note cap refuses it).
 */
export declare function note(rt: RuntimeContext, ctx: CoordinatorCtx, args: NoteArgs): Promise<boolean>;
