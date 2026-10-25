# Extract implementation record

## Scope

1. An independent `agevexExtract` component owns only `artifacts`; its nested
   Workflow component owns its own scheduling state. Offline generated bridges
   mirror core's checked-in bridges. Package exports cover the client, config,
   and generated component type.
2. `defineExtract` provides routing and hard registration bounds; direct UTF-8,
   single-request Firecrawl Parse/scrape, and AI SDK vision backends implement
   the documented backend contract.
3. `fromUrl` calls Firecrawl then Agent `storeFile`. `run` atomically admits and
   starts a Workflow; `get`, `readText`, `readPages`, and `release` use exact ids.
   Dispatch is claimed once. Expired or crashed claims become `unknown`; a
   released identity cannot publish late output. No paid automatic retry exists.
4. Eight closed failure codes, sanitized JSON, bounded summaries, and numeric
   usage only. Reported paid usage remains on failed/released/expired attempts.
   A failing host usage hook cannot restart provider work; the row retains usage.
5. Optional native RAG entry/chunk mutations and `search`; no chunk/vector
   copies. Default extraction never initializes RAG. Index admission fences paid
   embedding; native entry creation and its recorded id commit atomically.
   Explicit retries await deletion of the exact previous entry before creating
   another. Embedding errors suppress upstream automatic retries.
6. Thread-bound `read_file` and optional `search_files` provide bounded text and
   references. Ownership is the host's exact attachment check, called before
   reads and before/after backend work. Core slot/send wiring remains PR F.

## Table and fields

Only owned table: `artifacts`.

| Field                                                      | Why it is read                                                                                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_id`, `_creationTime`                                     | Convex document identity; `_id` addresses exact status, fence, read, release, and RAG references; `_creationTime` is Convex-managed metadata.                               |
| `fileId`                                                   | Exact Agent file access and host attachment authorization; identity index.                                                                                                  |
| `backend`, `version`                                       | Identity reuse and selecting the frozen backend implementation.                                                                                                             |
| `optionsHash`                                              | Identity lookup; default hashes the resolved extraction ceilings, excluding the indexing lease. Explicit overrides must be SHA-256 hex.                                     |
| `status`                                                   | Admission `reuse/wait/run`, dispatch guard, completion guard, readiness, and release.                                                                                       |
| `attempt`, `claim`                                         | Dispatch, completion, expiry, and abandon fences; RAG content identity. New identities start at attempt 1; expired attempts are never reclaimed.                            |
| `leaseUntil`                                               | Admission, dispatch, completion, and one-shot expiry recognize unknown outcomes.                                                                                            |
| `summary.kind`, `summary.textBytes`, `summary.pages`       | Returned status describes artifact type and read extent without fetching full JSON.                                                                                         |
| `summary.preview`, `summary.language`                      | Small status preview and optional backend language; never a provider body.                                                                                                  |
| `payloadStorageId`                                         | Exact host storage read, release cleanup, and stale-output cleanup.                                                                                                         |
| `failure`                                                  | Closed status code and its retryable classification. Retryable describes the cause, not permission for automatic replay.                                                    |
| `usage.inputTokens`, `usage.outputTokens`, `usage.credits` | Status/accounting evidence, including failures and late paid completion after release.                                                                                      |
| `indexStatus`                                              | Index admission waits on live `cleaning`/`running`, reuses `ready`, and explicitly recovers `unknown`/expired/failed attempts; writes, expiry, and search check it.         |
| `indexClaim`                                               | Fences entry creation, chunk writes, promotion, and the one-shot expiry check to the current indexing attempt.                                                              |
| `indexLeaseUntil`                                          | Entry creation, chunk writes, promotion, admission, and one-shot expiry reject an expired attempt. Default/hard maximum: 10 minutes; hosts may lower `limits.indexLeaseMs`. |
| `indexEntryId`                                             | Exact native RAG cleanup before retry, atomic promotion, returned id on reuse/wait, and filtering search to the current completed index.                                    |
| `indexNamespace`, `indexKey`                               | Reuse only the same requested index target; a different target cleans up the recorded previous entry first.                                                                 |

Request content, owner copies, file state, vectors, chunk state, and provider
bodies are not stored in this table. Native Agent owns files. Host storage owns
payload JSON. Native Workflow owns its journal. Native RAG owns vectors/chunks.

## Budget arithmetic

- Every artifact transaction reads at most one artifact, below 4 KiB, and writes
  at most one artifact, below 4 KiB. All identity strings cap at 256 UTF-8 bytes;
  SHA-256 is 64; preview is 1,024 bytes. No table read scales with file size,
  page count, payload size, or accumulated artifact count.
- Admission additionally performs one native Workflow start and one expiry
  scheduling operation, transactionally. Its id-only arguments cap below
  10 KiB (two handles at 4,096 bytes each plus bounded ids). The Workflow has
  one action and an optional completion mutation; no loop or idle chain.
- Input blob reads cap at 50,000,000 document / 10,000,000 image / 8,388,608 text
  bytes, with native storage metadata checked first and actual size/hash checked
  on lazy read. Routing and byte enforcement share the same text classifier:
  `text/*`, JSON, XML, CSV, and JavaScript application MIME types all use the text
  ceiling. Payload storage reads cap at 33,554,432 bytes before JSON parse.
  These are action storage operations, outside database transaction read limits.
- Output text caps at 1,048,576 UTF-8 bytes. Pages cap at 100 AND that aggregate
  byte ceiling; total payload pages cap at 10,000. A huge page returns a byte
  cursor. Tools cap at 65,536 bytes. Unicode continuation tests cover boundaries.
- RAG input caps at 1,048,576 text bytes and 1,024 chunks. Chunks cap at 8,192
  bytes; embedding dimension caps at 4,096 and must be supported upstream.
  A batch writes 100 content + 100 chunk + 100 vector rows: **300 rows**.
  Text appears twice (content and searchable text), and each Convex vector
  number costs 9 bytes including its type marker. With a 1 KiB allowance for
  fields/ids per triplet, `100 * (2 * 8192 + 4096 * 9 + 1024) = 5,427,200`
  bytes, **about 5.2 MiB**, below 16 MiB / 16,000 rows. A 10-result search with no
  neighboring context reads under 540 KiB of bounded chunk/vector/content data.
  A dedicated mount/namespace is required so foreign unbounded chunks cannot
  invalidate that bound. Final search text caps at 64 KiB.
- The index fence reads/patches one artifact. Starting an index additionally
  creates one small native entry in the same transaction; no chunks cross that
  transaction. The native key hashes `(artifactId, caller key)`, preventing
  unrelated artifacts sharing a caller key from accumulating native versions.
  Before a new entry exists, exact-id synchronous cleanup completes in native
  pages (8 MiB bandwidth threshold plus at most one bounded chunk's overhead).
  There is at most one pending entry per artifact, and therefore per native
  key. Promotion cannot collect a history of pending retries. A crashed index
  attempt becomes `unknown` after its independent lease expires, retaining the
  exact entry id. One scheduled check never reschedules or starts paid work.
  Only explicit host `index()` admission claims recovery, completes exact-id
  cleanup, and starts again. Native chunk writes and promotion share the
  transaction that checks the current claim and lease, fencing late writers.
- All deterministic component tests enforce convex-test transaction limits.
  The exact 32 MiB payload, 10,000 pages / 100-page window, 32 simultaneous
  admissions/dispatches, and 1 MiB RAG input at 4,096 dimensions are exercised.
  Index retries additionally exercise 32 partial failures followed by 32
  concurrent calls at those maximum input/chunk/vector bounds, checking native
  cleanup, the recorded in-flight id, successful completion, and free reuse.

## Source ladder and specification corrections

- Agent 0.7.7 installed source `src/vercel/client/files.ts:40` (`storeFile`) and
  `:157` (`getFile`) own file metadata/dedupe. The brief's `~/.opensrc/.../0.7.7`
  checkout does not exist; the installed pinned package was inspected instead.
- Prior art `component/extraction/policy/artifact.ts:10–19` retries expired and
  retryable attempts; `:25–32` implements release/attempt fencing. Only the fence
  was retained because retrying paid unknown outcomes conflicts with the rules.
- Firecrawl component 0.1.1 `src/client/index.ts:291` exposes scrape, not Parse;
  `src/component/api.ts:102–137` retries requests and buffers unbounded responses.
  Its component cannot meet the brief. A bounded one-request v2 adapter replaces
  that transport, without cloning its tables. Firecrawl Parse uses multipart.
- RAG 0.7.8 `src/client/index.ts:133` cannot continue an entry created by our
  admission transaction. Instead, its native `src/component/entries.ts:194`
  (`add`), `src/component/chunks.ts:50` (`insert`), and
  `src/component/entries.ts:398` (`promoteToReady`) own all entries/chunks/vectors;
  our thin action loop embeds batches of 100 with `maxRetries: 0`.
  `src/client/index.ts:768-786` provides `RAG.delete(ctx, { entryId })`, calling
  `entries.deleteSync`; `src/component/entries.ts:511-529` pages deletion by
  that exact id. Neither cleanup nor admission lists versions by key.
  The old native replace path collects pending versions at
  `src/component/chunks.ts:202`; promotion does so at
  `src/component/entries.ts:459`. Recording an id after native `RAG.add`
  returns would miss entries left behind by failed embedding, so recording
  happens transactionally before the first paid call instead.
  A model middleware still sanitizes RAG search embedding failures into
  non-retryable errors. RAG's source-only test export has a non-type import
  incompatible with verbatimModuleSyntax; tests load its runtime dynamically.
- Workflow 0.4.10 `src/client/step.ts:213` resolves function handles; Convex 1.47
  `src/server/components/paths.ts:28` accepts existing handles, letting
  the component own durability while the host owns configured backend code.
- The draft API omits required host wiring: `agent`, `worker`, `storageMetadata`,
  `authorize`, and `threadId`. `internalFunctions()` supplies the two host
  functions. The metadata query uses `_storage` instead of the deprecated
  `storage.getMetadata` syscall unsupported by convex-test. File tools need
  `tools({ ctx, threadId })` until PR F supplies the managed tool context.
- The draft says extraction attempts share core `receipts` while also requiring
  an independent component with `artifacts` only. Component isolation prevents
  that direct write. Admission, claim, lease, unknown, and completion mirror
  the core receipt state rules inside the permitted artifact row; no second
  ledger/table or core table dependency is introduced.
- The draft doesn't specify byte semantics for page reads. Pages are one-based;
  output has `{ pages, next: { from, cursor } | null }`, with UTF-8 byte cursors
  so a single page over 1 MiB remains readable without losing text. The bounded
  read_file tool also accepts a cursor so text/pages over 64 KiB remain readable.
- The RAG draft omits embedding dimensions and an indexing ceiling. The native
  component requires `embeddingDimension`; indexing caps at 1 MiB while
  extraction accepts 32 MiB payloads. Larger artifacts remain readable in
  windows; the host can intentionally index separate bounded sections later.

## Live evidence

Validated 2026-10-25: directText, one W3C dummy PDF Parse, one example.com
scrape, and one locally generated 190 × 48 PNG OCR all passed. Firecrawl:
**2 HTTP calls, 2 reported credits**. Requested `openrouter/free`; routed to
`nvidia/nemotron-3.5-super-vl:free`; **316 input / 310 output tokens**, one model
request. No key or provider error body was printed. Paid probes are not repeated
for a redundant acceptance invocation; empty key environment values skip them.
The PNG generator uses only local bitmap pixels and PNG compression.

## Test guarantees (test title and source)

- reuses an extraction identity without paying twice, including concurrent admission — [tests/extract/extract.test.ts:21](../../tests/extract/extract.test.ts).
- keeps options hash in artifact identity — [tests/extract/extract.test.ts:42](../../tests/extract/extract.test.ts).
- release wins over late completion and keeps paid usage without publishing output — [tests/extract/extract.test.ts:55](../../tests/extract/extract.test.ts).
- marks a lost provider outcome unknown and never retries it after lease expiry — [tests/extract/extract.test.ts:83](../../tests/extract/extract.test.ts).
- returns sanitized %s failures with paid usage and no automatic retry — [tests/extract/extract.test.ts:104](../../tests/extract/extract.test.ts).
- stores maximum-size payload JSON outside a small artifact row under transaction limits — [tests/extract/extract.test.ts:119](../../tests/extract/extract.test.ts).
- bounds UTF-8 text windows by bytes and resumes without splitting characters — [tests/extract/extract.test.ts:138](../../tests/extract/extract.test.ts).
- bounds page windows by both count and bytes and resumes a huge page — [tests/extract/extract.test.ts:161](../../tests/extract/extract.test.ts).
- read_file returns bounded text and references and checks the owning attachment — [tests/extract/extract.test.ts:191](../../tests/extract/extract.test.ts).
- keeps RAG opt-in and refuses index and search when unconfigured — [tests/extract/extract.test.ts:220](../../tests/extract/extract.test.ts).
- directText decodes local text and rejects unreadable or empty bytes without network — [tests/extract/extract.test.ts:233](../../tests/extract/extract.test.ts).
- rejects oversized registration limits and duplicate backend ids — [tests/extract/extract.test.ts:245](../../tests/extract/extract.test.ts).
- rejects oversized payloads without persisting provider fields and retains paid usage — [tests/extract/extract.test.ts:267](../../tests/extract/extract.test.ts).
- does not invoke a provider when native file bytes exceed the registered admission ceiling — [tests/extract/extract.test.ts:282](../../tests/extract/extract.test.ts).
- a duplicate worker dispatch cannot repeat a paid extraction — [tests/extract/extract.test.ts:315](../../tests/extract/extract.test.ts).
- changing a backend version creates a new artifact identity — [tests/extract/extract.test.ts:333](../../tests/extract/extract.test.ts).
- lease expiry fences a late paid completion and preserves its usage without retry — [tests/extract/extract.test.ts:352](../../tests/extract/extract.test.ts).
- rechecks the exact attachment after paid work before publishing output — [tests/extract/extract.test.ts:380](../../tests/extract/extract.test.ts).
- admits %s at its hard byte maximum with bounded transaction reads — [tests/extract/extract.test.ts:405](../../tests/extract/extract.test.ts).
- runs the completion callback after durable extraction without repeating it on reuse — [tests/extract/extract.test.ts:426](../../tests/extract/extract.test.ts).
- completion callbacks observe saved results even when the host usage hook fails — [tests/extract/extract.test.ts:445](../../tests/extract/extract.test.ts).
- Firecrawl parsing makes one bounded multipart request and keeps failure credits — [tests/extract/backends.test.ts:12](../../tests/extract/backends.test.ts).
- Firecrawl maps text pages without preserving provider response fields — [tests/extract/backends.test.ts:48](../../tests/extract/backends.test.ts).
- provider response reads stop at their byte ceiling without trusting headers — [tests/extract/backends.test.ts:75](../../tests/extract/backends.test.ts).
- directText rejects malformed UTF-8 and routes supported local formats — [tests/extract/backends.test.ts:90](../../tests/extract/backends.test.ts).
- vision OCR retains token usage and freezes model identity — [tests/extract/backends.test.ts:99](../../tests/extract/backends.test.ts).
- fromUrl stores the fetched markdown as a native Agent file and records credits — [tests/extract/backends.test.ts:110](../../tests/extract/backends.test.ts).
- indexes and searches through native RAG with maximum chunk, vector, and search bounds — [tests/extract/rag.test.ts:25](../../tests/extract/rag.test.ts).
- never retries a failed paid embedding request inside RAG — [tests/extract/rag.test.ts:61](../../tests/extract/rag.test.ts).
- repeated failed and concurrent indexing keeps one pending entry then succeeds under transaction limits — [tests/extract/rag.test.ts:87](../../tests/extract/rag.test.ts).
- %s fences indexing before a late embedding can publish (release and ownership) — [tests/extract/rag.test.ts:187](../../tests/extract/rag.test.ts).
- enforces the configured text ceiling for accepted %s files — [tests/extract/extract.test.ts:290](../../tests/extract/extract.test.ts).
- recovers a crash during cleaning after lease expiry and cleans the exact recorded entry — [tests/extract/rag.test.ts:309](../../tests/extract/rag.test.ts).
- recovers a crash during embedding after lease expiry with one replacement entry — [tests/extract/rag.test.ts:328](../../tests/extract/rag.test.ts).
- rejects stale chunk writes and promotion after explicit recovery claims an expired attempt — [tests/extract/rag.test.ts:344](../../tests/extract/rag.test.ts).
- expiry alone records unknown, retains the entry and never starts embedding or another timer — [tests/extract/rag.test.ts:382](../../tests/extract/rag.test.ts).
- validates indexing lease overrides against a positive integer hard maximum at registration — [tests/extract/rag.test.ts:401](../../tests/extract/rag.test.ts).
- rejects chunks and promotion at lease expiry before the scheduled check runs — [tests/extract/rag.test.ts:406](../../tests/extract/rag.test.ts).
- live directText reads an Agent text file without provider credits — [tests/extract/extract.live.ts:37](../../tests/extract/extract.live.ts).
- live Firecrawl parses one small public PDF and fetches one page within three calls — [tests/extract/extract.live.ts:43](../../tests/extract/extract.live.ts).
- live visionOcr transcribes one tiny PNG with openrouter/free and no retries — [tests/extract/extract.live.ts:81](../../tests/extract/extract.live.ts).

## Acceptance

Review fixes:

- `bun run check`, `bun run typecheck`, and `bun run typecheck:tests`: pass.
- `bunx vp test --run`: **231 tests passed** across 17 files, including 59 extract
  guarantees. Convex transaction limits remain enforced in the extract harness.
- All four indexing lease regressions failed against the original indexing
  implementation: cleaning/running never became unknown, and an expired
  explicit recovery returned pending. Lazy admission and one-shot expiry are
  covered, including stale chunk/promotion rejection before timer delivery.
- The RAG retry test failed on the original implementation with two pending
  entries after the second failure. XML/CSV/JavaScript application MIME tests
  failed because oversized files became ready. Release/ownership indexing tests
  failed because late embedding still published a ready entry.
- The multipart adapter already sent the correct request; the missing assertions
  are fixed. Four deliberate regressions (file, options, Content-Type boundary,
  abort signal) were each rejected by the strengthened test and then reverted.
- No live tests or providers ran again: **0 Firecrawl calls/credits**, no paid
  OCR or embedding tokens. All new embedding tests use fake models.
- Notes moved from `src/extract/IMPLEMENTATION.md` to `docs/notes/extract.md`,
  outside the package's `src`/`dist` file selection. Core sources and `bun.lock`
  are excluded from this change.

Original implementation evidence (historical):

- `bun run check`, `bun run typecheck`, and `bun run typecheck:tests`: pass.
- `bunx vp test --run`: **210 tests passed** across 17 files; 38 are extract
  guarantees, all under enforced transaction limits where Convex is involved.
- `bun run test:live:extract` with the requested keys: **3 live tests passed**.
- `FIRECRAWL_API_KEY= OPENROUTER_API_KEY= bun run test:live`: exits successfully;
  the core live scenario and two paid extract probes are explicitly skipped in
  this redundant acceptance invocation; local directText runs again. The real
  paid extract evidence above was collected once, keeping total spend at two
  Firecrawl requests/credits for this implementation run.
- Only module files, README, and module package entries are committed. The
  worktree's pre-existing lockfile edit is preserved and excluded; regenerate
  the combined dependency lock when integrating parallel optional modules.
