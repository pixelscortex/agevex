# SDK docs and registry

Local TanStack Start + Fumadocs site (React 19, Vite and Tailwind v4). This is an
independent Bun package: it is not part of the root library’s build, published
files or test globs. Root formatting, lint and type checks include the site.

```sh
cd docs/site
bun install
bun run dev
```

Open <http://localhost:3000/docs>. The dev server binds to `127.0.0.1:3000`.
The root URL redirects to `/docs`. Stop with Ctrl-C.

```sh
bun run build        # registry build, then TanStack Start/Nitro Bun build
bun run typecheck    # generate route types, then check site TypeScript
bun run start        # serve the production build locally
bun run registry:build
```

The registry command runs `bunx shadcn build`, writing
one `public/r/<item>.json` per registry item and copying the index to
`public/r/registry.json`.
Install from the local server with:

```sh
bunx shadcn add http://localhost:3000/r/todo.json
```

The items are bounded tools with host-owned state; see `content/docs/tools/`.

`site.config.ts` sets the provisional site title and registry namespace.
When renaming the package, update the plain MDX examples too. The registry
script updates the committed `registry.json` and generated item. The repository
URL derives from that name. There is no production host or registered shadcn
namespace yet.

Content lives in `content/docs`; every page must declare `status` as Available,
In progress or Planned. `src/lib/source.ts` validates this at build time. Only
current Workpool runtime basics are Available. All phase APIs from the draft
spec are Planned, including the preview one-screen setup. Spec snippets with
optional-property shorthand are contract sketches, not runnable TypeScript.

The site uses Fumadocs’ Base UI build and Spacious layout with the shadcn preset
and its neutral CSS variables, system fonts, built-in search, dark mode,
mobile navigation, code copying and Markdown/LLM routes. Builds do not fetch
Google Fonts. The local preview is marked noindex. API-reference generation
from package doc comments is future work; the current pages document the spec.

`components.json` configures shadcn's Base UI library and neutral palette; no
shadcn components are installed. Content uses normal MDX fenced code blocks
with languages and titles, highlighted by Fumadocs MDX's default Shiki pipeline.

The implementation follows the official Fumadocs `tanstack-start` template
from `bunx create-fumadocs-app@latest --template tanstack-start --pm bun`.
`src/routes` contains the file routes, `src/start.ts` handles Markdown content
negotiation, and `src/lib/source.ts` defines the async MDX collection and typed
status schema. The Vite MDX plugin compiles content without a separate source
configuration file. TanStack generates `src/routeTree.gen.ts` during dev/build.

AI-agent endpoints are `/llms.txt` and `/llms-full.txt` (plain text), plus
`/docs/index.md` and `/docs/<slug>.md` (per-page Markdown). A request to a docs
page with `Accept: text/markdown` redirects to its Markdown URL with
`Vary: Accept`. The Copy Markdown button uses that same endpoint. Search uses
`/api/search`. The previous `/llms.mdx/docs/.../content.md` URLs remain
available for compatibility. Docs use server rendering so content negotiation
also works in production; static prerendering would bypass Start's request middleware.

OG image generation is omitted: the template's Takumi WASM bundling failed
when prerendering the standalone Bun build. Page titles, descriptions and
noindex metadata are retained. `bun run start` previews the production output;
the standalone server can also run with `bun .output/server/index.mjs`.

Root verification remains separate:

```sh
bun run typecheck
bun run check
bunx vp test --run
```

Tooling uses Vite+ with the root Oxfmt and Oxlint configs. Run `bun run check`
from either package; docs route types are generated directly before TypeScript,
so checking needs no preceding dev server or build. The root check also checks
the library and test types and proves Convex rules reject invalid fixtures in
every component directory. `example/` is absent on this branch.

Type-aware linting is enabled. Test spies intentionally pass method references
to matchers, and assertion arrays intentionally use JavaScript's default lexical
sort, so those two type-aware style rules are disabled only for tests. Convex JS
plugins use their AST fallback because Oxlint does not expose ESLint parser
services. Public return-validator checking remains a review requirement: the
installed Convex plugin has no rule for it.
