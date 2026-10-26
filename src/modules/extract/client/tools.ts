/**
 * Thread-bound file reading and search tools for host/slot callers.
 * Host actions call these helpers with the resolved runtime context.
 * Durable state stays in the extract component; payload bytes stay in storage.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { LIMITS, bounded } from "../shared/limits.js";
import { subjectOf, type RuntimeContext, type Scoped } from "./context.js";
import { get } from "./files.js";
import { readPages, readText } from "./reads.js";
import { search } from "./search.js";
import type { ActionCtx } from "./types.js";
/** Bind model-visible file reads and search to the server-provided thread and subject. */
export function tools(runtime: RuntimeContext, context: Scoped & { ctx: ActionCtx }): ToolSet {
  bounded(context.threadId);

  if (context.subject !== undefined) bounded(context.subject);

  const owner = subjectOf(context);

  const read_file = tool({
    description:
      "Read bounded extracted file text. The file must be attached to this thread. Pass the returned next arguments to continue reading.",
    inputSchema: z.object({
      fileId: z.string().min(1).max(LIMITS.identifierBytes),
      page: z.number().int().min(1).max(LIMITS.totalPages).optional(),
      cursor: z.number().int().nonnegative().max(LIMITS.node.payloadBytes).optional(),
    }),
    execute: async ({ fileId, page, cursor }) => {
      const artifact = await get(runtime, context.ctx, {
        fileId,
        threadId: context.threadId,
        ...owner,
      });

      if (!artifact || artifact.status !== "ready")
        return {
          status: artifact?.status ?? "missing",
          // The typed failure (for example UNSUPPORTED_TYPE) is what the
          // model can act on; provider bodies never reach this field.
          ...(artifact?.failure ? { error: artifact.failure.code } : {}),
        };

      const args = {
        artifactId: artifact.artifactId,
        threadId: context.threadId,
        ...owner,
        maxBytes: LIMITS.toolBytes,
        cursor,
      };

      if (page !== undefined) {
        const result = await readPages(runtime, context.ctx, { ...args, from: page, count: 1 });

        return {
          text: result.pages[0]?.text ?? "",
          references: [{ fileId, artifactId: artifact.artifactId, page }],
          next: result.next ? { fileId, page: result.next.from, cursor: result.next.cursor } : null,
        };
      }

      const result = await readText(runtime, context.ctx, args);

      return {
        ...result,
        references: [{ fileId, artifactId: artifact.artifactId }],
        next: result.cursor === null ? null : { fileId, cursor: result.cursor },
      };
    },
  });

  if (!runtime.rag) return { read_file } satisfies ToolSet;

  const search_files = tool({
    description: "Search indexed files in this thread, returning bounded text and file references.",
    inputSchema: z.object({ query: z.string().min(1).max(LIMITS.queryBytes) }),
    execute: async ({ query }) =>
      search(runtime, context.ctx, {
        threadId: context.threadId,
        ...owner,
        namespace: context.threadId,
        query,
      }),
  });

  return { read_file, search_files } satisfies ToolSet;
}
