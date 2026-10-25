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
 * Daytona 2.1.0's host client owns lifecycle, exec and file writes
 * (src/client/index.ts:118-158,208-220,312-360). Only recovery
 * needs REST: src/component/daytona.ts:207-220 starts stopped/archived machines
 * but has no recover API for `error`. No credential enters our rows or jobs.
 *
 * Reads/listing use bounded Python through the component's run API because
 * files.ts:25-134 offers no byte/count bound; truncating AFTER that action
 * could already exceed Convex's return limit. Snapshots must include python3.
 * Never use runBackground: component/process.ts:427,491 schedules polls with
 * no deadline, including when the key disappears. Our only scheduled chain
 * is fenced by our jobs row; every provider interaction is a bounded run.
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
    async startBackground(ctx, sandboxId, cmd, job) {
      bounded(cmd, LIMITS.commandChars, "COMMAND");
      const jobId = job?.jobId ?? crypto.randomUUID();
      const directory = job?.directory ?? `${LIMITS.backgroundRoot}/${jobId}`;
      bounded(jobId, LIMITS.identityChars, "JOB_ID");
      bounded(directory, LIMITS.pathChars, "JOB_DIRECTORY");
      if (job && job.sandboxId !== sandboxId) throw new Error("SANDBOX_JOB_MISMATCH");
      // A new session gives the shell and all descendants a killable process
      // group. nohup survives the short exec's teardown; all descriptors are
      // detached. A nested shell preserves the exit file even for `exit 7`.
      // mkdir(exist_ok=False) refuses accidental replay of the same identity.
      const script = `sh -c ${quote(cmd)} > ${quote(`${directory}/output.log`)} 2>&1; status=$?; printf '%s' "$status" > ${quote(`${directory}/status.exit`)}`;
      await python(
        ctx,
        sandboxId,
        `import os,subprocess\nd=${JSON.stringify(directory)}\nos.makedirs(d,mode=0o700,exist_ok=False)\np=subprocess.Popen(['nohup','sh','-c',${JSON.stringify(script)}],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)\nwith open(d+'/group.pid','w') as f: f.write(str(p.pid))`,
        LIMITS.backgroundExecTimeoutS,
      );
      return { jobId, sandboxId, directory };
    },
    async poll(ctx, _jobId, { sandboxId, directory }) {
      bounded(directory, LIMITS.pathChars, "JOB_DIRECTORY");
      // tail -c bounds bytes at the source, rather than taking the end of
      // Daytona's truncated prefix. The component receives <=48 KiB of log
      // data (plus JSON escaping), regardless of the on-disk log's size.
      return JSON.parse(
        await python(
          ctx,
          sandboxId,
          `import os,json,subprocess\nd=${JSON.stringify(directory)}\nif os.path.exists(d+'/cancelled') or not os.path.exists(d+'/group.pid'):\n print(json.dumps({'state':'unknown'}))\nelif not os.path.exists(d+'/status.exit'):\n print(json.dumps({'state':'running'}))\nelse:\n with open(d+'/status.exit') as f: code=int(f.read(${LIMITS.identityChars}))\n log=subprocess.check_output(['tail','-c',str(${HARD_LIMITS.outputChars * LIMITS.utf8BytesPerChar}),d+'/output.log']).decode('utf-8',errors='replace')[-${HARD_LIMITS.outputChars}:]\n print(json.dumps({'state':'done' if code==0 else 'failed','exitCode':code,'logTail':log}))`,
          LIMITS.backgroundExecTimeoutS,
        ),
      );
    },
    async cancelBackground(ctx, _jobId, { sandboxId, directory }) {
      bounded(directory, LIMITS.pathChars, "JOB_DIRECTORY");
      // A deadline ends the entire group, not just the shell. Missing files
      // mean an unacknowledged start; never rerun the launch to discover it.
      await python(
        ctx,
        sandboxId,
        `import os,signal\nd=${JSON.stringify(directory)}\nif not os.path.exists(d+'/status.exit') and os.path.exists(d+'/group.pid'):\n with open(d+'/group.pid') as f: pid=int(f.read(${LIMITS.identityChars}))\n assert pid>1\n try: os.killpg(pid,signal.SIGKILL)\n except ProcessLookupError: pass\n with open(d+'/cancelled','w') as f: f.write('deadline')`,
        LIMITS.backgroundExecTimeoutS,
      );
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
      if (content.byteLength > LIMITS.exportChunkBytes) throw new Error("SANDBOX_UPLOAD_TOO_LARGE");
      await client.writeFileBytes(ctx, { sandboxId, path, content });
    },
    async download(ctx, sandboxId, path, { maxBytes, offset = 0, totalSizeLimit = maxBytes }) {
      bounded(path, LIMITS.pathChars, "PATH");
      integer(maxBytes, LIMITS.exportChunkBytes, "EXPORT_WINDOW");
      integer(totalSizeLimit, HARD_LIMITS.exportBytes, "EXPORT_SIZE");
      integer(offset, HARD_LIMITS.exportBytes, "EXPORT_OFFSET", 0);
      // process.run records stdout in executions (process.ts:99-105), so
      // base64 stdout would leak file bytes into component mutation args and
      // rows. Stage one <=512 KiB window, return only its path, then use the
      // non-recording files.readFileBytes API (files.ts:61-74). This also
      // bounds that otherwise-unbounded file API BEFORE its action returns.
      const result = await python(
        ctx,
        sandboxId,
        `import os,stat,tempfile\nf=open(${JSON.stringify(path)},'rb')\ns=os.fstat(f.fileno())\nassert stat.S_ISREG(s.st_mode),'regular files only'\nif s.st_size>${totalSizeLimit}: print('TOO_LARGE')\nelse:\n os.makedirs(${JSON.stringify(LIMITS.exportRoot)},mode=0o700,exist_ok=True)\n fd,p=tempfile.mkstemp(dir=${JSON.stringify(LIMITS.exportRoot)})\n f.seek(${offset})\n with os.fdopen(fd,'wb') as out: out.write(f.read(${maxBytes}))\n print(p)`,
      );
      if (result.trim() === "TOO_LARGE") throw new Error("SANDBOX_EXPORT_TOO_LARGE");
      const windowPath = bounded(result.trim(), LIMITS.pathChars, "EXPORT_WINDOW_PATH");
      try {
        const bytes = new Uint8Array(
          await client.readFileBytes(ctx, { sandboxId, path: windowPath }),
        );
        if (bytes.byteLength > maxBytes) throw new Error("SANDBOX_EXPORT_WINDOW_TOO_LARGE");
        return bytes;
      } finally {
        await client.deleteFile(ctx, { sandboxId, path: windowPath });
      }
    },
  };
}
