/**
 * Core slot admission and thread-bound tools, plus the exact-attachment policy.
 * Installing hosts call these adapters; core depends only on the slot contract.
 * Authorization resolves exact file attachments without transcript scans.
 */
import type { ToolSet } from "ai";
import type { ExtractSlot } from "../../../client/slots.js";
import type { ActionCtx, ExtractOptions } from "./types.js";
/**
 * agevex adapter for the `extract` slot.
 *
 * Core never imports this module: it only knows the `ExtractSlot` contract
 * (`src/client/slots.ts`) and calls it at two points of a managed turn.
 *
 * - `run`: at the first slice of a turn, once per file attached to that user
 *   message, with the server-derived thread owner. Core has already proven
 *   (atomically with saving the message) that the subject owns every file, so
 *   this is only an admission request. The module's own admission
 *   (`artifacts.admit`: reuse | wait | run) is the sole deduplication: a
 *   replayed slice, a retried send or the same file attached to a later message
 *   returns `reuse`/`wait` and never starts paid work twice. The subject rides
 *   in the durable job's arguments so the background worker, which has no
 *   session, can authorize without looking anything up.
 * - `tools`: per slice, bound to the running thread and subject. The tools are
 *   the module's own `read_file` (and `search_files` when RAG is configured).
 *   The thread and subject come from the server-built `ToolContext`, never from
 *   model input, so the model cannot name another thread to read.
 *
 * `autoIndex` (a module option, default off) additionally indexes each file
 * into the thread's namespace, and is what makes the slot offer `search_files`.
 *
 * Authorization is the host's `authorize` callback on `defineExtract`; see
 * `authorizeAttached` below for the agevex implementation.
 */
export declare function extractSlot(api: {
    run(ctx: ActionCtx, args: {
        threadId: string;
        fileId: string;
        subject: string;
    }): Promise<{
        artifactId: string;
        action: "run" | "wait" | "reuse";
    }>;
    index(ctx: ActionCtx, args: {
        threadId: string;
        subject: string;
        artifactId: string;
        namespace: string;
        key: string;
        automatic?: boolean;
    }): Promise<unknown>;
    tools(context: {
        ctx: ActionCtx;
        threadId: string;
        subject: string;
    }): ToolSet;
}, autoIndex: boolean): ExtractSlot;
/** Fixed index key for automatic indexing: repeated runs reuse the one entry. */
export declare const AUTO_INDEX_KEY = "auto";
/** The part of the agevex runtime the attachment policy needs. */
type AttachmentRuntime = {
    fileAttached(ctx: ActionCtx, args: {
        threadId: string;
        fileId: string;
        subject: string;
    }): Promise<boolean>;
};
/**
 * Build the `authorize` callback of `defineExtract` for agevex-managed threads.
 *
 * ```ts
 * authorize: authorizeAttached(() => runtime)
 * ```
 *
 * `runtime` is passed lazily because `registerAgent({ extract: extract.slot() })`
 * and `defineExtract({ authorize })` reference each other.
 *
 * Every file operation (`run`, `get`, reads, the worker's `execute`) must carry
 * the thread owner and pass `runtime.fileAttached(subject, threadId, fileId)`,
 * an indexed exact-attachment lookup that also checks the thread belongs to
 * that subject. A call without a subject is denied.
 *
 * Operations without a file (`search`, `index`) are allowed only for the
 * subject-bound slot tools' own namespace, which is the thread id. They read no
 * file by themselves: search rechecks every hit's file, and index loads its
 * artifact through the file check above. Everything else, such as `fromUrl`,
 * is denied: write your own `authorize` if you need it.
 */
export declare function authorizeAttached(runtime: () => AttachmentRuntime): ExtractOptions["authorize"];
export {};
