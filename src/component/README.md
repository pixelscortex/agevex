# Component ownership

Mount `agevex/convex.config` beside the host's native Agent component. Native
Agent owns threads, messages, titles and summaries. Workflow owns journals,
events, dispatch and nested cancellation. Core never imports an optional module.
The host exports `runTurn`, `coordinate` and, when enabled, `textTask`.

## Execution

1. The host saves a native user prompt and calls `turns.send.accept` in the
   same transaction. Acceptance creates its run budget, ready inbox reference
   and request receipt.
2. `turns/wake.ts` reserves the oldest ready row and starts or pings the loop.
   A coalesced doorbell and finite recovery check protect the atomic handoff.
3. The loop dispatches one non-retried host action per paid model slice.
   `turns/claim.ts` consumes ready work, flushes app notes and arms its watchdog.
4. Every native write passes the token/epoch fence in `turns/write.ts`. Exact
   message, stream, usage and approval identities commit with their native saves.
5. Tool steps continue through `turns/boundaries.ts`; approval resumes retain
   the reporting request, accumulated assistant ids and spent step allowance.
6. `turns/finish.ts` idles a successful turn or records recovery_required. Child
   settlement waits for descendants, pending deliveries and ready work.
7. The coordinator verifies the exact child result and saves it natively in the
   parent. `subagents/deliver.ts` independently enqueues each result and wakes
   the parent. Failed delivery cannot silently become a successful delivery.

`beforeTurn` selects an allowlisted model locally on every generation step,
including tool and approval resumes. It owns no persisted routing state or
sibling lock. `afterTurn` only notifies the host with `{ turn, text, messageIds }`.
The host can call public send/runtime APIs to request additional work.

A watchdog, dispatch failure or unknown execution parks work for explicit
recovery; no paid generation is automatically retried. Cancellation fences the
root and every live descendant before cancelling workflows. Exact-id cleanup
jobs close native placeholders, streams and approval requests separately.

## Queues and budgets

User work, parent messages and progress notes respect queueLength. Final child
results always enter the ready queue, including beside a reserved approval
head. Launch admission reserves final-result hops; questions reserve answer
hops. Ordinary messages cannot spend those reservations.

runLaunches bounds launches per request and outstanding direct-child result
work per assignment across requests. Launch admission counts pending deliveries
and ready result rows. Delivery replaces a pending result; claim consumes ready
rows. Only launch increases the total. The current-epoch by_parent_delivery
range excludes cancelled history. Exhaustion returns RESULTS_PENDING; budget
exhaustion returns RUN_BUDGET. Root activeRuns also bounds all live descendants.

At hard maxima, each assignment has at most 100 queued messages +50 results
+2 head/answer rows. Cancellation covers 16*152=2,432 ready rows and deduplicates
at most 168 budgets. Its conservative ceilings are 14,168 KiB read and 10,572 KiB
written, below 16 MiB. Passive note bodies are excluded and cleaned separately.
The complete document/query/byte arithmetic lives in `limits.ts`, with enforced
transaction-limit fixtures for cancellation, claim, decisions, tree and saves.

Assignments fit 16 KiB, including system fields. The maximal all-fields fixture
uses 12,672 bytes: approvals 4,802; reporting 2,635; text handles 822; pending
generation 988; runTurn 258; names 1,204; models 510; limits 309; remaining fields,
names and object overhead 1,144. This leaves 3,712 bytes of headroom. Native
saves clear active tool markers before growing the row; their own writer also
checks the envelope. Runs stay within 16 KiB, delegations within 4 KiB.

## Thread metadata

Only textConfig remains on assignments: worker/native thread handles and
feature enablement. Temporary run/epoch/first-message identities use existing
receipts and disappear when work closes. No generated content is copied there.
Titles generate once from the first accepted native prompt. The commit reads
native title and updates it atomically, so app/user titles always win.

Summaries are explicit requests with requestKey idempotency. Input uses Agent's
bounded recent-message query: at most 24 successful non-tool messages, a 2 MiB
page budget plus at most one <=1 MiB crossing document. The native thread read
adds at most 1 MiB in a separate query. Serialized input is <=48 KiB of messages
plus <=8 KiB of previous native summary. Results update native threads.summary;
the read endpoint queries that same native field. Unknown paid work is never
retried; a fresh key explicitly requests new work. Workflow cleanup is finite.

## Tables and readers

| Table        | Purpose and readers                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| assignments  | Thread ownership; dispatch, epoch/token fences, queue and note counters, approval refs, run linkage and bounded reporting. Read by admission, claim, write, watchdog, recovery, cancellation and projections. |
| inbox        | Ready native message references, temporary app/parent note bodies and saved origin labels. Read by ready-range probes, claim, note cleanup and page-local origins.                                            |
| runs         | Accepted request policy, native task/result links, lifecycle snapshots, launch/hop budgets, cancellation and usage completeness. Read by claim, effect admission, settlement and tree.                        |
| receipts     | Request/tool idempotency, compact decision proposals, native attachment grants and temporary text capabilities. Each variant has its own lifecycle and indexed readers.                                       |
| subagentRuns | Delegation identity, root epoch, parent/child links, exact task/result/question ids, delivery capability/status, message caps and bounded events. Read by launch, interaction, settlement, delivery and tree. |

inbox.text remains only for app notes and message_parent notes until their safe
native save. noteEpoch isolates cancelled payloads. passive=true holds unsaved
notes; passive=false retains saved origin labels. Ready ranges select absent
passive only, so retained labels cannot wake work or fence settlement.

turnReport records the logical request and exact successful assistant ids in
native save order. maxMessages enforces the resolved step cap; resumeInboxId
preserves the report and allowance through approval resumes. New user, queued
or child work resets it. At most 64*(37+2)=2,496 bytes of ids plus prompt/cap/resume
metadata fit a 3 KiB reservation. ToolContext.promptMessageId uses that request.

## Module map

- turns/: acceptance, claims, native write fences, bounded decisions, cancellation,
  watchdogs, recovery, FIFO handoff, slice boundaries and root lifecycle.
- subagents/: reservations, parent/child messages, verified settlement, result
  delivery, history and root-inclusive tree projections.
- hooks/: shared note admission/saving and page-local origin lookups only.
- text/: receipt-backed non-retried metadata dispatch and native commits.
- receipts/: shared idempotency/lease ledger and bounded indexed retention cleanup.
- files/: native attachment grants and exact message bindings.
- cancellation/: finite native stream/placeholder/decision cleanup.
- workflows/: versioned root/child loop and turn journals with retries disabled.

Loops rotate after bounded turns/doorbells to protect the 8 MiB journal. The
versioned step sequence remains stable and journal replay tests verify it.
agevex/test mounts inspection functions only in the test harness.
