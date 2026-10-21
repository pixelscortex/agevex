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

Start both Convex and the playground together from the repository root:

```bash
cd ..
bun run examples:dev
```

This builds the local `agevex` package, installs the example dependencies, then
starts `convex dev` and Vite together. The Convex process creates
`convex/_generated/` and keeps the backend running.

`OPENROUTER_API_KEY` is read only by the Convex deployment. Do not put it in
the playground's browser environment.

In a second terminal, after Convex has printed its deployment URL, upload the
deployment variables:

```bash
cd examples
npx convex env set --from-file .env.local
```

Vite reads `VITE_CONVEX_URL` from the generated `examples/.env.local`.

The demo fallback is disabled by default. To use it locally, set
`AGEVEX_ALLOW_ANONYMOUS=true` in the deployment and keep the deployment
private. Replace it with the host's real authorization policy before deploying
an application.
