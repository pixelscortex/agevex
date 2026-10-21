# Agevex example app

This is one standalone app:

- `convex/` — the Convex backend that mounts native Agent and Agevex.
- `src/` — the TanStack Router React client with locally owned shadcn/ui
  components.

## Run the playground

Build Agevex first from the repository root:

```bash
bun install --frozen-lockfile
bun run build
```

Install the example dependencies and prepare local deployment values:

```bash
cd examples
bun install --frozen-lockfile
cp .env.example .env.local
# For this private local demo, edit .env.local and set AGEVEX_ALLOW_ANONYMOUS=true.
```

Start the local Convex deployment in terminal 1:

```bash
bun run dev
```

The local `convex dev` process creates `convex/_generated/`. Keep it running
because it also hosts the local backend.

`OPENROUTER_API_KEY` is read only by the Convex deployment. Do not put it in
the playground's browser environment.

In terminal 2, upload the local deployment variables:

```bash
cd examples
npx convex env set --from-file .env.local
```

In terminal 3, start the client:

```bash
cd examples
VITE_CONVEX_URL=http://127.0.0.1:3210 bun run dev:playground
```

The demo fallback is disabled by default. To use it locally, set
`AGEVEX_ALLOW_ANONYMOUS=true` in the deployment and keep the deployment
private. Replace it with the host's real authorization policy before deploying
an application.
