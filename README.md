# agevex

A Workflow-backed Convex component and host client for managed
`@convex-dev/agent` agents. Native Agent owns threads, messages, tools and
streaming; agevex adds bounded execution, delegation, authorization and receipts.
Git-only, private package, **UNLICENSED**.

## Setup

Use Bun. Build the checkout before installing it in a host; package exports
resolve to `dist/`.

```sh
bun install
bun run build
```

In your host app, install the built checkout and matching peer dependencies:

```sh
bun add /absolute/path/to/agevex
bun add convex@1.47.0 @convex-dev/agent@0.7.7 ai@7.0.153 convex-helpers@0.1.128 @ai-sdk/provider@4.0.34 @ai-sdk/provider-utils@5.0.68
```

Follow [Getting started](docs/site/content/docs/getting-started.mdx) to mount
the components, register agents and export authorized host endpoints.

## Documentation

- [Architecture and source maps](docs/site/content/docs/concepts/architecture.mdx)
- [Runtime and per-agent settings](docs/site/content/docs/concepts/runtime.mdx)
- [Host limits and hard bounds](docs/site/content/docs/concepts/limits.mdx)
- [Receipts and paid effects](docs/site/content/docs/concepts/receipts.mdx)
- [Delegation](docs/site/content/docs/concepts/delegation.mdx)
- [React hooks](docs/site/content/docs/concepts/react-hooks.mdx)
- [Usage and budgets](docs/site/content/docs/concepts/recording-usage.mdx)
- [Sandbox module](docs/site/content/docs/modules/sandbox.mdx)
- [Testing](docs/site/content/docs/testing.mdx)
- [Contributing](docs/site/content/docs/contributing.mdx)

## Development

```sh
bun install --cwd docs/site
bun run check
bunx vitest run --maxWorkers=2
bun run check:deploy
bun run --cwd docs/site build
```

`check` covers formatting, lint, source/test/docs types and Convex lint.
`check:deploy` mounts the built package on a throwaway local anonymous backend.
The default tests use offline fakes; see the testing guide for opt-in live tests.
