import {
  Daytona,
  type ComponentApi,
  type CreateSandboxArgs,
  type DaytonaOptions,
} from "@daytona/convex";
import { HARD_LIMITS, LIMITS, bounded, integer } from "./limits.js";
import type { FileEntry, SandboxContext, SandboxProvider } from "./types.js";

export type DaytonaSandboxOptions = DaytonaOptions & {
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  snapshot?: string;
  target?: string;
};

function quote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
}

/**
 * Daytona 2.1.0's host client owns lifecycle, exec, file writes and background
 * sessions/polling (src/client/index.ts:118-158,208-267,312-360). Only recovery
 * needs REST: src/component/daytona.ts:207-220 starts stopped/archived machines
 * but has no recover API for `error`. No credential enters our rows or jobs.
 *
 * Reads/listing use bounded Python through the component's run API because
 * files.ts:25-134 offers no byte/count bound; truncating AFTER that action
 * could already exceed Convex's return limit. Snapshots must include python3.
 */
export function daytona(
  component: ComponentApi,
  opts: DaytonaSandboxOptions = {},
): SandboxProvider {
  const autoStopInterval = integer(
    opts.autoStopInterval ?? LIMITS.daytonaAutoStopMinutes,
    LIMITS.daytonaTimerMaxMinutes,
    "AUTO_STOP",
    0,
  );
  const autoArchiveInterval = integer(
    opts.autoArchiveInterval ?? LIMITS.daytonaAutoArchiveMinutes,
    LIMITS.daytonaTimerMaxMinutes,
    "AUTO_ARCHIVE",
    0,
  );
  if (opts.snapshot !== undefined) bounded(opts.snapshot, LIMITS.identityChars, "SNAPSHOT");
  if (opts.target !== undefined) bounded(opts.target, LIMITS.identityChars, "TARGET");
  const client = new Daytona(component, opts);

  async function python(
    ctx: SandboxContext,
    sandboxId: string,
    source: string,
    timeoutS: number = LIMITS.commandTimeoutS,
  ) {
    const result = await client.run(ctx, {
      sandboxId,
      command: `python3 -c ${quote(source)}`,
      timeoutSeconds: timeoutS,
      autoStart: false,
    });
    if (result.exitCode !== 0) throw new Error("SANDBOX_DAYTONA_OPERATION_FAILED");
    return result.result;
  }

  async function read(
    ctx: SandboxContext,
    sandboxId: string,
    path: string,
    maxBytes: number,
    tail: boolean,
  ) {
    bounded(path, LIMITS.pathChars, "PATH");
    integer(maxBytes, HARD_LIMITS.fileReadChars * LIMITS.utf8BytesPerChar, "FILE_BYTES");
    // Read <=maxBytes+1, even if the file grows after the size check. Export
    // refuses overflow, while text reads retain the tail. The largest reply
    // is ceil(640000/3)*4 <854 KiB base64, below Convex's return ceiling.
    const result = await python(
      ctx,
      sandboxId,
      `import os,stat,base64\np=${JSON.stringify(path)}\nn=${maxBytes}\nf=open(p,'rb')\ns=os.fstat(f.fileno())\nassert stat.S_ISREG(s.st_mode),'regular files only'\n${tail ? "f.seek(max(0,s.st_size-n))" : "assert s.st_size<=n,'file too large'"}\nb=f.read(n+1)\nassert len(b)<=n,'file too large'\nprint(base64.b64encode(b).decode())`,
    );
    const bytes = decodeBase64(result.trim());
    if (bytes.byteLength > maxBytes) throw new Error("SANDBOX_FILE_TOO_LARGE");
    return bytes;
  }

  return {
    id: "daytona",
    async create(ctx, { scopeKey }) {
      bounded(scopeKey, LIMITS.scopeKeyChars, "SCOPE");
      const args: CreateSandboxArgs = {
        snapshot: opts.snapshot,
        target: opts.target,
        autoStopInterval,
        autoArchiveInterval,
        // Daytona auto-delete 0 destroys the filesystem when stopping; -1
        // disables deletion. Only the explicit host TTL cleanup can delete.
        autoDeleteInterval: LIMITS.disabledAutoDelete,
        wait: false,
        public: false,
        userKey: scopeKey,
        labels: { agevexScope: scopeKey },
      };
      const created = await client.createSandbox(ctx, args);
      return { sandboxId: created.sandboxId };
    },
    async resume(ctx, sandboxId) {
      const known = await client.refreshSandbox(ctx, { sandboxId });
      if (!known || known.state === "destroyed") throw new Error("SANDBOX_GONE");
      if (known.state === "error") {
        // Narrow bridge matching the SDK's recover route. Confirm recoverable
        // first; never delete/recreate to hide an error and lose the files.
        const apiKey = opts.apiKey ?? process.env.DAYTONA_API_KEY;
        if (!apiKey) throw new Error("SANDBOX_DAYTONA_KEY_REQUIRED");
        const root = (
          opts.apiUrl ??
          process.env.DAYTONA_API_URL ??
          "https://app.daytona.io/api"
        ).replace(/\/+$/, "");
        const url = `${root}/sandbox/${encodeURIComponent(sandboxId)}`;
        const headers = { Authorization: `Bearer ${apiKey}` };
        const inspected = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(LIMITS.daytonaRequestMs),
        });
        if (!inspected.ok) throw new Error("SANDBOX_RECOVERY_UNAVAILABLE");
        const state = (await inspected.json()) as { state?: string; recoverable?: boolean };
        if (state.state !== "error" || state.recoverable !== true)
          throw new Error("SANDBOX_NOT_RECOVERABLE");
        const recovered = await fetch(`${url}/recover`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(LIMITS.daytonaRequestMs),
        });
        if (!recovered.ok) throw new Error("SANDBOX_RECOVERY_UNKNOWN");
      }
      await client.startSandbox(ctx, { sandboxId, waitTimeoutMs: LIMITS.daytonaReadyMs });
    },
    async stop(ctx, sandboxId) {
      await client.stopSandbox(ctx, { sandboxId, waitTimeoutMs: LIMITS.daytonaReadyMs });
    },
    async delete(ctx, sandboxId) {
      await client.deleteSandbox(ctx, { sandboxId });
    },
    async exec(ctx, sandboxId, cmd, { timeoutS, signal }) {
      signal.throwIfAborted();
      bounded(cmd, LIMITS.commandChars, "COMMAND");
      integer(timeoutS, HARD_LIMITS.commandTimeoutS, "COMMAND_TIMEOUT");
      // Provider run truncates the HEAD at 4M chars (process.ts:105). Collect
      // to temporary files inside the sandbox, then transfer bounded tails so
      // arbitrary command output never crosses the component boundary first.
      // The command executes exactly once. A timeout kills its process group.
      const chars = HARD_LIMITS.outputChars;
      const result = JSON.parse(
        await python(
          ctx,
          sandboxId,
          `import subprocess,tempfile,json,os,signal\no=tempfile.TemporaryFile()\ne=tempfile.TemporaryFile()\np=subprocess.Popen(${JSON.stringify(cmd)},shell=True,stdout=o,stderr=e,start_new_session=True)\ntry:\n p.wait(timeout=${timeoutS})\nexcept subprocess.TimeoutExpired:\n os.killpg(p.pid,signal.SIGKILL)\n p.wait()\ndef tail(f):\n f.seek(0,2)\n f.seek(max(0,f.tell()-${chars * LIMITS.utf8BytesPerChar}))\n return f.read().decode('utf-8',errors='replace')[-${chars}:]\nprint(json.dumps({'exitCode':p.returncode,'stdout':tail(o),'stderr':tail(e)}))`,
          timeoutS,
        ),
      ) as { exitCode: number; stdout: string; stderr: string };
      signal.throwIfAborted();
      return result;
    },
    async startBackground(ctx, sandboxId, cmd) {
      const result = await client.runBackground(ctx, { sandboxId, command: cmd, autoStart: false });
      return { jobId: result.executionId };
    },
    async poll(ctx, jobId) {
      const execution = await client.getExecution(ctx, { executionId: jobId });
      if (!execution) return { state: "unknown" };
      const output = {
        ...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
        logTail: (execution.result ?? "").slice(-HARD_LIMITS.outputChars),
      };
      if (execution.status === "running") return { state: "running", ...output };
      if (execution.status === "completed") return { state: "done", ...output };
      // A provider "failed" row without an exit code can be a lost network
      // response or failed kill, not evidence that the command failed safely.
      return {
        state:
          execution.status === "failed" && execution.exitCode !== undefined ? "failed" : "unknown",
        ...output,
      };
    },
    async readFile(ctx, sandboxId, path, { maxBytes }) {
      return new TextDecoder().decode(await read(ctx, sandboxId, path, maxBytes, true));
    },
    async writeFile(ctx, sandboxId, path, content) {
      bounded(path, LIMITS.pathChars, "PATH");
      if (content.length > HARD_LIMITS.writeChars) throw new Error("SANDBOX_WRITE_TOO_LARGE");
      await client.writeFile(ctx, { sandboxId, path, content });
    },
    async listFiles(ctx, sandboxId, path, { limit }) {
      bounded(path, LIMITS.pathChars, "PATH");
      integer(limit, HARD_LIMITS.listEntries, "LIST_ENTRIES");
      const result = JSON.parse(
        await python(
          ctx,
          sandboxId,
          `import os,itertools,json\nwith os.scandir(${JSON.stringify(path)}) as d:\n print(json.dumps([{'name':e.name[:${LIMITS.pathChars}],'isDir':e.is_dir(follow_symlinks=False)} for e in itertools.islice(d,${limit})]))`,
        ),
      ) as FileEntry[];
      return result;
    },
    async upload(ctx, sandboxId, path, content) {
      bounded(path, LIMITS.pathChars, "PATH");
      if (content.byteLength > HARD_LIMITS.exportBytes) throw new Error("SANDBOX_UPLOAD_TOO_LARGE");
      await client.writeFileBytes(ctx, { sandboxId, path, content });
    },
    download: (ctx, sandboxId, path, { maxBytes }) => read(ctx, sandboxId, path, maxBytes, false),
  };
}
