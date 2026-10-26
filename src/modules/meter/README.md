# meter

Meter is an optional Convex component with a host client. Mount it through `agevex/meter/convex.config` and import its API from `agevex/meter`.

`component/` runs inside Convex, `client/index.ts` exposes the host API, `shared/` holds pure contracts and bounds used by both, and `test.ts` registers this component and its children with convex-test.

Host implementation: `client/client.ts`, `helpers.ts`, `sinks.ts` and `types.ts`. Shared bounds, breakdowns and worker contracts live in `shared/`. Component writes, reads and projections live in `component/charges.ts`, `reads.ts` and `aggregates.ts`.

See [API.md](API.md) for the full API, budgets and delivery guarantees.
