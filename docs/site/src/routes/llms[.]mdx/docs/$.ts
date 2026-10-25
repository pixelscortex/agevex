import { createFileRoute, notFound } from "@tanstack/react-router";
import { docsLlms, source } from "@/lib/source";

// Preserve the original Markdown URLs alongside the native /docs/<slug>.md routes.
export const Route = createFileRoute("/llms.mdx/docs/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const segments = params._splat?.split("/") ?? [];

        if (segments.pop() !== "content.md") throw notFound();

        const page = source.getPage(segments);

        if (!page) throw notFound();

        return new Response(await docsLlms.page(page), {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});
