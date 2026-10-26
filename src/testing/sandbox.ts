/**
 * Deterministic in-memory sandbox provider for offline behavior tests.
 * Lifecycle, execution queues and bounded filesystem operations share isolated state.
 * Hooks simulate uncertain provider outcomes without shell commands or credentials.
 */
import type { SandboxProvider, JobOutcome, FileEntry } from "../modules/sandbox/client/types.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  SandboxWriteError,
  validateWriteCommit,
  validateWriteWindow,
} from "../modules/sandbox/shared/write.js";

type FakeMachine = {
  state: "creating" | "ready" | "stopped" | "archived" | "error" | "deleted";
  files: Map<string, Uint8Array>;
  /** Last write time (ms) of staged files, so tests can age an abandoned stage. */
  touched: Map<string, number>;
};
type ExecResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
type FakeOptions = {
  exec?: (command: string, sandboxId: string) => Promise<ExecResult> | ExecResult;
  beforeReady?: (sandboxId: string) => Promise<void>;
  create?: () => Promise<void>;
  background?: (command: string) => JobOutcome[];
};
type FakeContext = {
  opts: FakeOptions;
  sandboxes: Map<string, FakeMachine>;
  jobs: Map<string, JobOutcome[]>;
  calls: {
    create: number;
    resume: number;
    stop: number;
    delete: number;
    exec: string[];
    background: string[];
    poll: string[];
    cancel: string[];
  };
  nextSandbox: number;
  nextJob: number;
};
/** In-memory provider: deterministic, no fetch, no shell, no provider credentials. */
export function fakeSandboxProvider(opts: FakeOptions = {}) {
  const runtime: FakeContext = {
    opts,
    sandboxes: new Map(),
    jobs: new Map(),
    calls: {
      create: 0,
      resume: 0,
      stop: 0,
      delete: 0,
      exec: [],
      background: [],
      poll: [],
      cancel: [],
    },
    nextSandbox: 0,
    nextJob: 0,
  };

  const provider: SandboxProvider = {
    id: "fake",
    ...fakeLifecycle(runtime),
    ...fakeExecution(runtime),
    ...fakeFiles(runtime),
    ...fakeBinaryWrites(runtime),
  };

  return { provider, sandboxes: runtime.sandboxes, jobs: runtime.jobs, calls: runtime.calls };
}

/** Mirror staged offset checks and atomic replacement without exposing partial targets. */
function fakeBinaryWrites(
  runtime: FakeContext,
): Pick<SandboxProvider, "writeWindow" | "commitWrite" | "discardWrite" | "reclaimWrites"> {
  return {
    async writeWindow(_ctx, id, path, offset, content) {
      validateWriteWindow(path, offset, content);
      const { files, touched } = ready(runtime, id);
      const existing = files.get(path) ?? new Uint8Array();

      if (existing.length !== offset) {
        if (
          offset + content.length <= existing.length &&
          content.every((byte, i) => byte === existing[offset + i])
        )
          return;

        throw new SandboxWriteError("SANDBOX_WRITE_OFFSET_MISMATCH");
      }

      const next = new Uint8Array(offset + content.length);

      next.set(existing);
      next.set(content, offset);
      files.set(path, next);
      touched.set(path, Date.now());
    },
    async commitWrite(_ctx, id, tempPath, path, expected) {
      validateWriteCommit(tempPath, path, expected.bytes, expected.sha256);
      const { files, touched } = ready(runtime, id);
      const staged = files.get(tempPath);

      if (
        !staged ||
        staged.length !== expected.bytes ||
        bytesToHex(sha256(staged)) !== expected.sha256
      )
        throw new SandboxWriteError("SANDBOX_WRITE_INCOMPLETE");

      files.set(path, staged);
      files.delete(tempPath);
      touched.delete(tempPath);
    },
    async discardWrite(_ctx, id, path) {
      const { files, touched } = ready(runtime, id);

      files.delete(path);
      touched.delete(path);
    },
    async reclaimWrites(_ctx, id, directory, prefix, olderThanMs) {
      const { files, touched } = ready(runtime, id);

      for (const path of files.keys()) {
        const name = path.slice(directory.length);

        if (
          path.startsWith(directory) &&
          !name.includes("/") &&
          name.startsWith(prefix) &&
          name.endsWith(".tmp") &&
          Date.now() - (touched.get(path) ?? 0) > olderThanMs
        ) {
          files.delete(path);
          touched.delete(path);
        }
      }
    },
  };
}

/** Require an existing machine before any fake effect. */
function machine(runtime: FakeContext, id: string) {
  const { sandboxes } = runtime;
  const found = sandboxes.get(id);

  if (!found || found.state === "deleted") throw new Error("FAKE_SANDBOX_GONE");

  return found;
}

/** Reject file and exec access while the fake is stopped. */
function ready(runtime: FakeContext, id: string) {
  const found = machine(runtime, id);

  if (found.state !== "ready") throw new Error("FAKE_SANDBOX_STOPPED");

  return found;
}

/** Read only files owned by a ready fake machine. */
function bytes(runtime: FakeContext, id: string, path: string) {
  const file = ready(runtime, id).files.get(path);

  if (!file) throw new Error("FAKE_FILE_NOT_FOUND");

  return file;
}

/** Bind deterministic lifecycle behavior to this fake's isolated state. */
function fakeLifecycle(
  runtime: FakeContext,
): Pick<SandboxProvider, "create" | "resume" | "stop" | "delete"> {
  const { opts, sandboxes, calls } = runtime;

  return {
    async create() {
      calls.create++;
      await opts.create?.();
      const sandboxId = `fake-sandbox-${++runtime.nextSandbox}`;

      sandboxes.set(sandboxId, { state: "creating", files: new Map(), touched: new Map() });

      return { sandboxId };
    },
    async resume(_ctx, id) {
      calls.resume++;
      const found = machine(runtime, id);

      await opts.beforeReady?.(id);
      found.state = "ready";
    },
    async stop(_ctx, id) {
      calls.stop++;
      machine(runtime, id).state = "stopped";
    },
    async delete(_ctx, id) {
      calls.delete++;
      const found = sandboxes.get(id);

      if (found) found.state = "deleted";
    },
  };
}

/** Bind deterministic execution behavior to this fake's isolated state. */
function fakeExecution(
  runtime: FakeContext,
): Pick<SandboxProvider, "exec" | "startBackground" | "poll" | "cancelBackground"> {
  const { opts, jobs, calls } = runtime;

  return {
    async exec(_ctx, id, command, { signal }) {
      signal.throwIfAborted();
      ready(runtime, id);
      calls.exec.push(command);

      return opts.exec ? opts.exec(command, id) : { exitCode: 0, stdout: command, stderr: "" };
    },
    async startBackground(_ctx, id, command, job) {
      ready(runtime, id);
      calls.background.push(command);
      const jobId = job?.jobId ?? `fake-job-${++runtime.nextJob}`;

      jobs.set(
        jobId,
        opts.background?.(command) ?? [
          { state: "running" },
          { state: "done", exitCode: 0, logTail: "done" },
        ],
      );

      return { jobId, sandboxId: id, directory: job?.directory ?? `/tmp/fake/${jobId}` };
    },
    async poll(_ctx, id) {
      calls.poll.push(id);
      const results = jobs.get(id);

      if (!results?.length) return { state: "unknown" };

      return results.length === 1 ? results[0] : results.shift()!;
    },
    async cancelBackground(_ctx, id) {
      calls.cancel.push(id);
      jobs.set(id, [{ state: "unknown" }]);
    },
  };
}

/** Bind deterministic files behavior to this fake's isolated state. */
function fakeFiles(
  runtime: FakeContext,
): Pick<SandboxProvider, "readFile" | "writeFile" | "listFiles" | "upload" | "download"> {
  return {
    async readFile(_ctx, id, path, { maxBytes }) {
      return new TextDecoder().decode(bytes(runtime, id, path).slice(-maxBytes));
    },
    async writeFile(_ctx, id, path, content) {
      ready(runtime, id).files.set(path, new TextEncoder().encode(content));
    },
    async listFiles(_ctx, id, path, { limit }) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const result = new Map<string, FileEntry>();

      for (const [name, content] of ready(runtime, id).files) {
        if (!name.startsWith(prefix)) continue;

        const relative = name.slice(prefix.length);
        const first = relative.split("/")[0];

        if (first)
          result.set(first, {
            name: first,
            isDir: relative.includes("/"),
            size: content.byteLength,
          });

        if (result.size >= limit) break;
      }

      return [...result.values()];
    },
    async upload(_ctx, id, path, content) {
      ready(runtime, id).files.set(path, new Uint8Array(content));
    },
    async download(_ctx, id, path, { maxBytes, offset = 0, totalSizeLimit = maxBytes }) {
      const content = bytes(runtime, id, path);

      if (content.byteLength > totalSizeLimit) throw new Error("SANDBOX_EXPORT_TOO_LARGE");

      return content.slice(offset, offset + maxBytes);
    },
  };
}
