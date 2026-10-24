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
5. Optional native RAG `add`/`search`; no chunk/vector copies. Default extraction
   never initializes RAG. Embedding errors suppress upstream automatic retries.
6. Thread-bound `read_file` and optional `search_files` provide bounded text and
   references. Ownership is the host's exact attachment check, called before
   reads and before/after backend work. Core slot/send wiring remains PR F.

## Table and fields

Only owned table: `artifacts`.

| Field                                                      | Why it is read                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_id`, `_creationTime`                                     | Convex document identity; `_id` addresses exact status, fence, read, release, and RAG references; `_creationTime` is Convex-managed metadata.    |
| `fileId`                                                   | Exact Agent file access and host attachment authorization; identity index.                                                                       |
| `backend`, `version`                                       | Identity reuse and selecting the frozen backend implementation.                                                                                  |
| `optionsHash`                                              | Identity lookup; default hashes the resolved limits. Explicit overrides must be SHA-256 hex.                                                     |
| `status`                                                   | Admission `reuse/wait/run`, dispatch guard, completion guard, readiness, and release.                                                            |
| `attempt`, `claim`                                         | Dispatch, completion, expiry, and abandon fences; RAG content identity. New identities start at attempt 1; expired attempts are never reclaimed. |
| `leaseUntil`                                               | Admission, dispatch, completion, and one-shot expiry recognize unknown outcomes.                                                                 |
| `summary.kind`, `summary.textBytes`, `summary.pages`       | Returned status describes artifact type and read extent without fetching full JSON.                                                              |
| `summary.preview`, `summary.language`                      | Small status preview and optional backend language; never a provider body.                                                                       |
| `payloadStorageId`                                         | Exact host storage read, release cleanup, and stale-output cleanup.                                                                              |
| `failure`                                                  | Closed status code and its retryable classification. Retryable describes the cause, not permission for automatic replay.                         |
| `usage.inputTokens`, `usage.outputTokens`, `usage.credits` | Status/accounting evidence, including failures and late paid completion after release.                                                           |

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
  on lazy read. Payload storage reads cap at 33,554,432 bytes before JSON parse.
  These are action storage operations, outside database transaction read limits.
- Output text caps at 1,048,576 UTF-8 bytes. Pages cap at 100 AND that aggregate
  byte ceiling; total payload pages cap at 10,000. A huge page returns a byte
  cursor. Tools cap at 65,536 bytes. Unicode continuation tests cover boundaries.
- RAG input caps at 1,048,576 text bytes and 1,024 chunks. Chunks cap at 8,192
  bytes; embedding dimension caps at 4,096 and must be supported upstream.
  RAG batches 100 chunks: `100 * (8192 + 4096 * 8 + 1024) = 4,198,400` bytes,
  below 16 MiB, at most 201 writes, below 16,000. A 10-result search with no
  neighboring context reads under 420 KiB of bounded chunk/vector metadata.
  A dedicated mount/namespace is required so foreign unbounded chunks cannot
  invalidate that bound. Final search text caps at 64 KiB.
- All deterministic component tests enforce convex-test transaction limits.
  The exact 32 MiB payload, 10,000 pages / 100-page window, 32 simultaneous
  admissions/dispatches, and 1 MiB RAG input at 4,096 dimensions are exercised.

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
- RAG 0.7.8 `src/client/index.ts:133` owns batched indexing and `:368` owns
  retrieval; `src/shared.ts:16` sets batches to 100. Its embedding helper doesn't
  expose `maxRetries`; a model middleware sanitizes failures to non-retryable
  errors. RAG's source-only test export also has a non-type import incompatible
  with verbatimModuleSyntax; its runtime harness is loaded dynamically in tests.
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
- returns sanitized %s failures with paid usage and no automatic retry — [tests/extract/extract.test.ts:95](../../tests/extract/extract.test.ts).
- stores maximum-size payload JSON outside a small artifact row under transaction limits — [tests/extract/extract.test.ts:119](../../tests/extract/extract.test.ts).
- bounds UTF-8 text windows by bytes and resumes without splitting characters — [tests/extract/extract.test.ts:138](../../tests/extract/extract.test.ts).
- bounds page windows by both count and bytes and resumes a huge page — [tests/extract/extract.test.ts:161](../../tests/extract/extract.test.ts).
- read_file returns bounded text and references and checks the owning attachment — [tests/extract/extract.test.ts:191](../../tests/extract/extract.test.ts).
- keeps RAG opt-in and refuses index and search when unconfigured — [tests/extract/extract.test.ts:220](../../tests/extract/extract.test.ts).
- directText decodes local text and rejects unreadable or empty bytes without network — [tests/extract/extract.test.ts:233](../../tests/extract/extract.test.ts).
- rejects oversized registration limits and duplicate backend ids — [tests/extract/extract.test.ts:245](../../tests/extract/extract.test.ts).
- rejects oversized payloads without persisting provider fields and retains paid usage — [tests/extract/extract.test.ts:267](../../tests/extract/extract.test.ts).
- does not invoke a provider when native file bytes exceed the registered admission ceiling — [tests/extract/extract.test.ts:282](../../tests/extract/extract.test.ts).
- a duplicate worker dispatch cannot repeat a paid extraction — [tests/extract/extract.test.ts:290](../../tests/extract/extract.test.ts).
- changing a backend version creates a new artifact identity — [tests/extract/extract.test.ts:308](../../tests/extract/extract.test.ts).
- lease expiry fences a late paid completion and preserves its usage without retry — [tests/extract/extract.test.ts:327](../../tests/extract/extract.test.ts).
- rechecks the exact attachment after paid work before publishing output — [tests/extract/extract.test.ts:355](../../tests/extract/extract.test.ts).
- admits %s at its hard byte maximum with bounded transaction reads — [tests/extract/extract.test.ts:375](../../tests/extract/extract.test.ts).
- runs the completion callback after durable extraction without repeating it on reuse — [tests/extract/extract.test.ts:401](../../tests/extract/extract.test.ts).
- completion callbacks observe saved results even when the host usage hook fails — [tests/extract/extract.test.ts:420](../../tests/extract/extract.test.ts).
- Firecrawl parsing makes one bounded multipart request and keeps failure credits — [tests/extract/backends.test.ts:12](../../tests/extract/backends.test.ts).
- Firecrawl maps text pages without preserving provider response fields — [tests/extract/backends.test.ts:27](../../tests/extract/backends.test.ts).
- provider response reads stop at their byte ceiling without trusting headers — [tests/extract/backends.test.ts:54](../../tests/extract/backends.test.ts).
- directText rejects malformed UTF-8 and routes supported local formats — [tests/extract/backends.test.ts:69](../../tests/extract/backends.test.ts).
- vision OCR retains token usage and freezes model identity — [tests/extract/backends.test.ts:78](../../tests/extract/backends.test.ts).
- fromUrl stores the fetched markdown as a native Agent file and records credits — [tests/extract/backends.test.ts:89](../../tests/extract/backends.test.ts).
- indexes and searches through native RAG with maximum chunk, vector, and search bounds — [tests/extract/rag.test.ts:22](../../tests/extract/rag.test.ts).
- never retries a failed paid embedding request inside RAG — [tests/extract/rag.test.ts:58](../../tests/extract/rag.test.ts).
- live directText reads an Agent text file without provider credits — [tests/extract/extract.live.ts:37](../../tests/extract/extract.live.ts).
- live Firecrawl parses one small public PDF and fetches one page within three calls — [tests/extract/extract.live.ts:42](../../tests/extract/extract.live.ts).
- live visionOcr transcribes one tiny PNG with openrouter/free and no retries — [tests/extract/extract.live.ts:80](../../tests/extract/extract.live.ts).

## Acceptance

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
