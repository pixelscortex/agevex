# extract

Extract is an optional Convex component with a host client. Mount it through `agevex/extract/convex.config` and import its API from `agevex/extract`.

`component/` runs inside Convex, `client/index.ts` exposes the host API, `shared/` holds pure contracts and bounds used by both, and `test.ts` registers this component and its children with convex-test.
