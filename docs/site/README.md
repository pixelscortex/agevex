# SDK docs and registry

Local Next.js + Fumadocs site. This is an independent Bun package: it is not
part of the root library’s build, published files, lint or test globs.

```sh
cd docs/site
bun install
bun run dev
```

Open <http://localhost:3000/docs>. The dev server binds to `127.0.0.1:3000`.
The root URL redirects to `/docs`. Stop with Ctrl-C.

```sh
bun run build        # registry build, then Next.js production build
bun run typecheck    # Next route types and site TypeScript
bun run start        # serve the production build locally
bun run registry:build
```

The registry command runs `bunx shadcn build`, writing
`public/r/todo-tool.json`. Install from the local server with:

```sh
bunx shadcn add http://localhost:3000/r/todo-tool.json
```

The todo tool is a bounded, in-memory demonstration. It needs host
authorization and Agent-component storage before real use.

`site.config.ts` is the single source for the provisional package name, site
title and registry namespace. Change the name there, then rebuild; the registry
script updates the committed `registry.json` and generated item. The repository
URL derives from that name. There is no production host or registered shadcn
namespace yet.

Content lives in `content/docs`; every page must declare `status` as Available,
In progress or Planned. `lib/source.ts` validates this at build time. Only
current Workpool runtime basics are Available. All phase APIs from the draft
spec are Planned, including the preview one-screen setup. Spec snippets with
optional-property shorthand are contract sketches, not runnable TypeScript.

The site uses Fumadocs’ neutral theme, system fonts, built-in search, dark mode,
mobile navigation, code copying and Markdown/LLM routes. Builds do not fetch
Google Fonts. The local preview is marked noindex. API-reference generation
from package doc comments is future work; the current pages document the spec.

Root verification remains separate:

```sh
bun run typecheck
bun run check
bunx vp test --run
```
