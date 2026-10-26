# meter

Optional cost accounting and budget gates for agevex. Stable charge and operation
keys prevent replay billing; unknown costs deny the next budget check. Aggregate
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

## File map

Paths below are relative to this module. Internal builders are not package exports.

- `client/index.ts`: public host exports.
- `client/client.ts`: `defineMeter` composition and inferred public result types.
- `client/configuration.ts`: resolved context, registration validation, authorization and worker handles.
- `client/pricing.ts`: inline evidence, profile estimates, credit conversion and unknown reasons.
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
- `component/charge-contracts.ts`: unchanged argument validators and inferred handler inputs.
- `component/charge-creation.ts`: creation validation, replay ownership and initial charge rows.
- `component/charge-records.ts`: bounded key reads, charge views, terminal predicates and receipt snapshots.
- `component/charge-updates.ts`: amount transitions, correction/settlement precedence and projection replacement.
- `component/charge-lookup.ts`: request attachment, one-shot expiry and fenced lookup results.
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
then inserts the charge and its aggregate entries. Authoritative cost prepares
immutable sink events; delivery claims small outbox rows and acknowledges in
bounded chunks. Corrections/settlements save their original operation outcomes.
Attachment records an exact provider request and deadline; read-only lookup
retries are fenced, and expiry fails the gate closed. Retention removes only
settled, fully acknowledged charges and their projections, on host demand.
