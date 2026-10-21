# Agevex examples

The examples are intentionally split into two small, independently runnable
projects:

- `convex/` — a host application that mounts native Agent and Agevex, defines a
  real OpenRouter-backed agent, and exports the managed endpoints.
- `playground/` — a TanStack Router React client that consumes those endpoints
  through Convex and uses locally owned shadcn/ui components.

## Run the playground

Build Agevex first from the repository root:

```bash
bun install --frozen-lockfile
bun run build
```

In `examples/convex`, install the example backend dependencies and provide the
deployment values:

```bash
cd examples/convex
bun install --frozen-lockfile
cp .env.example .env.local
# `.env.local` is read by the CLI only; upload deployment values explicitly:
npx convex env set --from-file .env.local
bun run dev
```

The first `convex dev` run creates `convex/_generated/`. Run it before building
the playground because the client imports the generated host API.

`OPENROUTER_API_KEY` is read only by the Convex deployment. Do not put it in
the playground's browser environment.

In another terminal, install and start the client:

```bash
cd examples/playground
bun install --frozen-lockfile
VITE_CONVEX_URL=https://<your-deployment>.convex.cloud bun run dev
```

The demo fallback is disabled by default. To use it locally, set
`AGEVEX_ALLOW_ANONYMOUS=true` in the deployment and keep the deployment
private. Replace it with the host's real authorization policy before deploying
an application.
