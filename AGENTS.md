# agevex

agevex is a headless Convex component and host client for managed agents. Native
Agent owns messages; agevex adds Workflow coordination, bounded execution,
fences, receipts, and optional modules. Core never imports an optional module.

## Layout

- `src/component/`: core Convex functions, schema and generated types.
- `src/client/`: core API imported by the host app; `src/test.ts`: registration.
- `src/modules/{meter,sandbox,extract}/`: `component/` runs in Convex,
  `client/index.ts` is the host entry, `shared/` is pure code used by both sides,
  and `test.ts` registers that component and its nested dependencies.
- `src/modules/telemetry/client/`: host library, no component or tables.
- `src/modules/tools/`: host factories in `client/`, installable host state and
  schemas in `registry/`. Rebuild the docs registry after changing an item.
- `src/testing/`: shared deterministic test utilities; `tests/<module>/`: tests.
- `docs/site/`: independent Bun docs/registry app, included in root checks.

Component code never imports a client. Preserve component and function names.
Package subpaths are `agevex/<module>`, with `/convex.config`, `/test` and
`/_generated/component.js` for modules that own components.

## Commands

Use `bun`/`bunx` only. Install dependencies with `bun install` and
`bun install --cwd docs/site`.

- `bun run check`: Oxfmt check, Oxlint, library/test/docs types and Convex lint gate.
- `bun run fmt`: format; `bun run lint`: lint with type-aware checks.
- `bun run test`: offline fake backends, two workers, no prior build required.
- `bun run test:live`: opt-in OpenRouter, Daytona, Firecrawl and telemetry checks.
  Keys come from `/Volumes/mypixel/pxc/agevex/.env.local`: `OPENROUTER_API_KEY`,
  `DAYTONA_API_KEY`, `FIRECRAWL_API_KEY`; telemetry also needs the Langfuse keys
  and base URL. Never print secrets. Use `openrouter/free`; at most three
  Firecrawl calls and one smallest, cheapest image per full live run.

## Conventions

Bound every read by count and bytes, including at hard maximum host overrides.
Keep numeric limits in a module LIMITS object and validate overrides. Documents
must fit 1 MiB; large payloads belong in storage. Explain budget arithmetic in
comments and enforce transaction limits in hard-maximum convex-test fixtures.

Preserve execution fences across cancellation and replay. Use stable receipt
keys for paid effects; never automatically retry an unknown paid outcome.
Record exact native message/stream IDs in the creating transaction; never scan
transcripts. Host wrappers own authorization and environment access. Public
functions need args and returns validators; use indexed, bounded queries.

Tests assert promised behavior, with a title naming each guarantee. Keep
functions at most 90 lines; report existing oversized functions for the next
refactor. Give files header comments and explain why non-obvious rules exist.
Use conventional local commits, no AI attribution, and never push unasked.
Do not edit `docs/spec/`, `.repo/`, `.codegraph/` or `example/` for these briefs.

## Convex skills

Use `.agents/skills/convex-create-component/SKILL.md` for component boundaries,
`convex-design/SKILL.md` for backend design, `convex-reviewer/SKILL.md` for review,
and `convex-test/SKILL.md` for tests (the latter three are also under
`.agents/skills/`). Installed skills are pinned in `skills-lock.json`;
`.claude/skills` links to that same directory.

If this checkout has a `.codegraph/` directory, use `codegraph explore` before
searching or reading source to locate or understand code. Do not create an index
unless asked.
