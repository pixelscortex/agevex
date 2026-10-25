import type { SandboxProvider, JobOutcome, FileEntry } from "../sandbox/types.js";

type FakeMachine = {
  state: "creating" | "ready" | "stopped" | "archived" | "error" | "deleted";
  files: Map<string, Uint8Array>;
};
type ExecResult = { exitCode: number; stdout: string; stderr: string };

/** In-memory provider: deterministic, no fetch, no shell, no provider credentials. */
export function fakeSandboxProvider(
  opts: {
    exec?: (command: string, sandboxId: string) => Promise<ExecResult> | ExecResult;
    beforeReady?: (sandboxId: string) => Promise<void>;
    create?: () => Promise<void>;
    background?: (command: string) => JobOutcome[];
  } = {},
) {
  const sandboxes = new Map<string, FakeMachine>();
  const jobs = new Map<string, JobOutcome[]>();
  const calls = {
    create: 0,
    resume: 0,
    stop: 0,
    delete: 0,
    exec: [] as string[],
    background: [] as string[],
    poll: [] as string[],
    cancel: [] as string[],
  };
  let nextSandbox = 0;
  let nextJob = 0;
  const machine = (id: string) => {
    const found = sandboxes.get(id);
    if (!found || found.state === "deleted") throw new Error("FAKE_SANDBOX_GONE");
    return found;
  };
  const ready = (id: string) => {
    const found = machine(id);
    if (found.state !== "ready") throw new Error("FAKE_SANDBOX_STOPPED");
    return found;
  };
  const bytes = (id: string, path: string) => {
    const file = ready(id).files.get(path);
    if (!file) throw new Error("FAKE_FILE_NOT_FOUND");
    return file;
  };
  const provider: SandboxProvider = {
    id: "fake",
    async create() {
      calls.create++;
      await opts.create?.();
      const sandboxId = `fake-sandbox-${++nextSandbox}`;
      sandboxes.set(sandboxId, { state: "creating", files: new Map() });
      return { sandboxId };
    },
    async resume(_ctx, id) {
      calls.resume++;
      const found = machine(id);
      await opts.beforeReady?.(id);
      found.state = "ready";
    },
    async stop(_ctx, id) {
      calls.stop++;
      machine(id).state = "stopped";
    },
    async delete(_ctx, id) {
      calls.delete++;
      const found = sandboxes.get(id);
      if (found) found.state = "deleted";
    },
    async exec(_ctx, id, command, { signal }) {
      signal.throwIfAborted();
      ready(id);
      calls.exec.push(command);
      return opts.exec ? opts.exec(command, id) : { exitCode: 0, stdout: command, stderr: "" };
    },
    async startBackground(_ctx, id, command, job) {
      ready(id);
      calls.background.push(command);
      const jobId = job?.jobId ?? `fake-job-${++nextJob}`;
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
    async readFile(_ctx, id, path, { maxBytes }) {
      return new TextDecoder().decode(bytes(id, path).slice(-maxBytes));
    },
    async writeFile(_ctx, id, path, content) {
      ready(id).files.set(path, new TextEncoder().encode(content));
    },
    async listFiles(_ctx, id, path, { limit }) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const result = new Map<string, FileEntry>();
      for (const [name, content] of ready(id).files) {
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
      ready(id).files.set(path, new Uint8Array(content));
    },
    async download(_ctx, id, path, { maxBytes, offset = 0, totalSizeLimit = maxBytes }) {
      const content = bytes(id, path);
      if (content.byteLength > totalSizeLimit) throw new Error("SANDBOX_EXPORT_TOO_LARGE");
      return content.slice(offset, offset + maxBytes);
    },
  };
  return { provider, sandboxes, jobs, calls };
}
