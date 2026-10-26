# meter

Optional cost accounting and budget gates for agevex. Stable charge and operation
keys prevent replay billing; unknown costs deny the next budget check, except
unknown background title/summary charges, which never block their run. Aggregate
reads stay bounded, and the sink outbox delivers known amounts independently of
the budget decision. Core never imports this module.

`component/` runs in its own Convex component. `client/` runs in the installing
app's server functions/actions, where authorization, provider callbacks and sink
credentials belong. `shared/` contains pure contracts used on both sides.

## Wiring

Mount `agevex/meter/convex.config` in the host's `convex.config.ts` as `meter`.
Define and export the host workers in the module named by `workers`:

```ts
// convex/billing.ts
import { defineMeter, inline } from "agevex/meter";
import { components, internal } from "./_generated/api";

export const meter = defineMeter(components.meter, {
  providers: { openrouter: inline() },
  workers: {
    lookup: internal.billing.meterLookup,
    deliver: internal.billing.meterDeliver,
  },
  budgets: () => ({ maxUsd: 5 }),
});
export const { meterLookup, meterDeliver } = meter.internalFunctions();
```

Pass `usage: meter.usageSlot()` and `budget: meter.budgetSlot()` to
`registerAgent`. Core supplies attribution and stable keys for saved model steps
and managed tools. Standalone calls use `meter.scope(ctx, attribution)` with
explicit keys. Authorize public host wrappers; the optional `authorize` callback
guards standalone operations, while core slots trust server-derived attribution.
`prune` requires the host's own admin guard. See [API.md](API.md) for provider
profiles, sinks, breakdown opt-ins, retention and the full guarantees.

Custom sinks use `{ name?, estimates?: true, deliver(batch, ctx) }`. `ctx` is the
delivery worker's host action context, so delivery can call host internal
mutations. Existing one-argument callbacks remain valid. Set `estimates: true`
per sink (supported by `webhookSink`, never by `polarSink`, which bills what it
ingests and so only receives final amounts) to receive initial known estimates;
the default keeps waiting for correction or authoritative cost. The opt-in is
frozen when each charge is created, without backfill.

Events freeze `status` and `source` alongside amount at enqueue time. A
same-amount classification change sends a new revision with `nanos: 0` and the
same absolute `totalNanos`. Retries preserve `externalId` and revision; recipients
deduplicate by `externalId`. Later revisions use `key:delta:revision` and retain
the original charge `key` so recipients can replace its absolute total.

## Live usage

`record` accepts an optional exact `requestId`. Configure `Provider.estimate` for
token estimates and `Provider.lookup` for read-only reconciliation;
`openRouterProvider({ apiKey, estimate? })` supplies inline and generation-cost
adapters. `tokenEstimate({ inputUsdPerMillion, outputUsdPerMillion })` uses host
rates, supporting native Agent and AI SDK usage. Inline evidence wins.

Core sweeps pending charge ids on every slice exit, including early children.
Standalone calls use `meter.reconcile(ctx, { subject, runId })` after recording;
the same sweep is safe as a post-run backstop. Lookup results replace the original
contribution, never create a second charge. Missing/failed evidence retains the
estimate and bounded retries; charge `reconciliation` exposes status.

`usageView(ctx, { subject, runId, nodeIds, partial? })` reads run totals and at most
59 exclusive nodes from the existing aggregate children; `null` denotes root.
Costs distinguish estimates and settled values, missing tokens stay null, and
unknown cost reports partial coverage. Merge the sticky core run failure marker
from `turns.slices.usageReporting` through `partial`. The usage slot exposes the
same optional `view` and `reconcile` contracts, keeping core independent of meter.
Budget gates check the next model/tool boundary without reserving credits;
in-flight work and delayed costs can overshoot. Denial stops the run.

Schema additions stay on existing tables: charge attribution `purpose`/`nodeId`
selects exclusive projections; immutable `tokens` feed live counts;
`reconciliation` drives the indexed run sweep and worker fences. The existing
request-id/deadline/attempt fields drive provider lookups. Core `runs.usagePartial`
records observation failures without touching paid receipts. No new table.

## File map

Paths below are relative to this module. Internal builders are not package exports.

- `client/index.ts`: public host exports.
- `client/client.ts`: `defineMeter` composition and inferred public result types.
- `client/configuration.ts`: resolved context, registration validation, authorization and worker handles.
- `client/pricing.ts`: inline evidence, profile estimates, credit conversion and unknown reasons.
- `client/openrouter.ts`: bounded generation-cost HTTP adapter with host credentials.
- `client/scope.ts`: lazy attribution, trusted/host guards and charge recording.
- `client/handles.ts`: get, attach, correct and settle operations with stable receipt keys.
- `client/reads.ts`: authorized aggregate reads and budget snapshots.
- `client/slots.ts`: core usage/budget adapters and provider-name resolution.
- `client/maintenance.ts`: host retention and explicit sink retry calls.
- `client/workers.ts`: internal lookup/delivery action builders.
- `client/helpers.ts`: label hashing, OpenRouter evidence and standalone Agent observation adapters.
- `client/sinks.ts`: bounded Polar/webhook HTTP adapters and retry hints.
- `client/types.ts`: host contexts, providers, charges, sinks and registration types.
- `component/convex.config.ts`: two aggregate children and Workpool registration.
- `component/schema.ts`: `charges`, `deliveries`, `claims` and their indexed fields.
- `component/charges.ts`: stable charge, lookup, delivery and retention function registrations.
- `component/charge-contracts.ts`: lifecycle argument validators and inferred handler inputs.
- `component/charge-creation.ts`: creation validation, replay ownership and initial charge rows.
- `component/charge-records.ts`: bounded key reads, charge views, terminal predicates and receipt snapshots.
- `component/charge-updates.ts`: amount transitions, correction/settlement precedence and projection replacement.
- `component/charge-lookup.ts`: request attachment, one-shot expiry and fenced lookup results.
- `component/reconciliation.ts`: finite four-charge batches discovered through the run index.
- `component/usage-projections.ts`: exclusive node costs and run/node token contributions.
- `component/usage-views.ts`: bounded reactive views without charge scans.
- `component/outbox.ts`: immutable delivery row builders and charge/sink synchronization.
- `component/delivery.ts`: claims, acknowledgements, retry/crash accounting and explicit reset.
- `component/jobs.ts`: Workpool admission, handle typing and retry ceilings.
- `component/retention.ts`: terminal charge deletion within document/byte budgets.
- `component/aggregates.ts`: frozen projection membership, summaries and tree budget arithmetic.
- `component/reads.ts`: bounded thread pages, subject/run totals and subject breakdown queries.
- `component/_generated/`: offline component API, server and data-model types.
- `shared/breakdowns.ts`: opt-in projection names and disabled-projection errors.
- `shared/contracts.ts`: worker handle, lookup and delivery job validators.
- `shared/limits.ts`: hard maxima, bounded overrides and scalar validation.
- `test.ts`: convex-test registration of meter and its nested components.

## Charge lifecycle

Recording validates and authorizes, finds the exact key, checks root capacity,
then inserts the charge and its aggregate entries. Eligible cost prepares
immutable sink events; delivery claims small outbox rows and acknowledges in
bounded chunks. Corrections/settlements save their original operation outcomes.
Attachment records an exact provider request and deadline; read-only lookup
retries are fenced, and expiry retains the estimate for budgeting. Retention removes only
settled, fully acknowledged charges and their projections, on host demand.
