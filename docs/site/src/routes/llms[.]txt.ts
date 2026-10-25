import { docsLlms } from "@/lib/source";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async () =>
        // Retain the async boundary even when this version returns a plain string.
        // eslint-disable-next-line typescript/await-thenable
        new Response(await docsLlms.index(), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    },
  },
});
