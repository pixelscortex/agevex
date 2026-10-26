# extract

Optional extraction for native Agent attachments: one fenced receipt per file/backend/options
identity, storage-backed text and pages, and optional namespace-isolated RAG indexing. Paid
extraction and embedding are never retried automatically after an unknown outcome.

`component/` runs in Convex and owns `artifacts` receipts, `indexes` fences, and an id-only
Workflow. `client/` runs in host actions and owns authorization, storage, providers, RAG calls,
and tools. `shared/` is pure code used by both. Core never imports this module.

## Wiring

1. Mount `agevex/extract/convex.config` with `app.use(extract)` alongside native Agent.
2. Call `defineExtract(components.agevexExtract, options)` from `agevex/extract`. Supply the
   Agent component, backends (for example `directText()`), an `authorize` callback, and the
   internal `worker` and `storageMetadata` references exported from `internalFunctions()`.
3. Export `const { execute, storageMetadata } = extract.internalFunctions()` from the host
   worker file. Public wrappers authorize through the configured host policy.
4. For managed turns, pass `extract.slot()` to `registerAgent` and use
   `authorizeAttached(() => runtime)` to require the exact subject/thread/file attachment.
   With `rag` and `autoIndex`, the slot also offers `search_files` in the thread namespace.
5. Optionally export `extractNodeExport` from a host `"use node"` file and supply its `execute`
   and `read` references as `options.node` for the larger runtime byte ceilings.

Flow: `run` authorizes and resolves identity → component admits/reuses/waits → Workflow starts
one fenced worker → provider output is validated and stored → completion publishes metadata
and reports usage → reads reauthorize and return byte windows. Explicit `index` claims one
namespace record, deletes its exact predecessor, embeds bounded batches, and promotes under
the same fence. `release` removes one namespace; admin-only `purge` cleans shared file content
in bounded calls until `more` is false. Receipts survive purge to prevent accidental repeats.

## File map

- `client/index.ts`: public exports and short runtime composition.
- `client/context.ts`: registration validation, resolved bounds/model, request contracts.
- `client/access.ts`: exact file metadata, authorization, identity, artifact views, usage hook.
- `client/files.ts`: run/get and URL acquisition with accounting before output validation.
- `client/execute.ts`: one-shot worker, checksum, publication, uncertain-commit cleanup.
- `client/reads.ts`: metadata-first payload reads and bounded text/page windows.
- `client/indexing.ts`: index preflight, chunking, explicit admission, embedding, publication.
- `client/search.ts`: bounded RAG retrieval and per-hit attachment/index checks.
- `client/cleanup.ts`: namespace release and bounded administrative purge.
- `client/tools.ts`: thread-bound `read_file` and optional `search_files` tools.
- `client/registrations.ts`: host internal worker and exact storage metadata registrations.
- `client/adapter.ts`: core slot adapter and `authorizeAttached` policy.
- `client/backends.ts`: direct text, Firecrawl, vision OCR, sanitized provider errors.
- `client/payload.ts`: output validation, exact JSON sizing, usage sanitization, UTF-8 windows.
- `client/types.ts`: public backend, authorization, worker, and registration contracts.
- `component/artifacts.ts`: stable registered artifact API, completion/expiry/purge fences.
- `component/artifactAdmission.ts`: admission decisions, receipt builders, Workflow dispatch.
- `component/indexing.ts`: stable registered index API and atomic native RAG write fences.
- `component/workflows.ts`: id-only Workflow, callback draining, cleanup.
- `component/schema.ts`: bounded artifact/index rows and shared wire validators.
- `component/convex.config.ts`: component definition and nested Workflow installation.
- `component/_generated/`: component references, data model, and server types.
- `shared/limits.ts`: hard limits, memory/transaction arithmetic, validation, UTF-8 helpers.
- `test.ts`: convex-test registration including nested Workflow/Workpool dependencies.
