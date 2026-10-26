/** In-memory provider: deterministic, no fetch, no shell, no provider credentials. */
export function fakeSandboxProvider(opts = {}) {
    const runtime = {
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
    const provider = {
        id: "fake",
        ...fakeLifecycle(runtime),
        ...fakeExecution(runtime),
        ...fakeFiles(runtime),
    };
    return { provider, sandboxes: runtime.sandboxes, jobs: runtime.jobs, calls: runtime.calls };
}
/** Require an existing machine before any fake effect. */
function machine(runtime, id) {
    const { sandboxes } = runtime;
    const found = sandboxes.get(id);
    if (!found || found.state === "deleted")
        throw new Error("FAKE_SANDBOX_GONE");
    return found;
}
/** Reject file and exec access while the fake is stopped. */
function ready(runtime, id) {
    const found = machine(runtime, id);
    if (found.state !== "ready")
        throw new Error("FAKE_SANDBOX_STOPPED");
    return found;
}
/** Read only files owned by a ready fake machine. */
function bytes(runtime, id, path) {
    const file = ready(runtime, id).files.get(path);
    if (!file)
        throw new Error("FAKE_FILE_NOT_FOUND");
    return file;
}
/** Bind deterministic lifecycle behavior to this fake's isolated state. */
function fakeLifecycle(runtime) {
    const { opts, sandboxes, calls } = runtime;
    return {
        async create() {
            calls.create++;
            await opts.create?.();
            const sandboxId = `fake-sandbox-${++runtime.nextSandbox}`;
            sandboxes.set(sandboxId, { state: "creating", files: new Map() });
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
            if (found)
                found.state = "deleted";
        },
    };
}
/** Bind deterministic execution behavior to this fake's isolated state. */
function fakeExecution(runtime) {
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
            jobs.set(jobId, opts.background?.(command) ?? [
                { state: "running" },
                { state: "done", exitCode: 0, logTail: "done" },
            ]);
            return { jobId, sandboxId: id, directory: job?.directory ?? `/tmp/fake/${jobId}` };
        },
        async poll(_ctx, id) {
            calls.poll.push(id);
            const results = jobs.get(id);
            if (!results?.length)
                return { state: "unknown" };
            return results.length === 1 ? results[0] : results.shift();
        },
        async cancelBackground(_ctx, id) {
            calls.cancel.push(id);
            jobs.set(id, [{ state: "unknown" }]);
        },
    };
}
/** Bind deterministic files behavior to this fake's isolated state. */
function fakeFiles(runtime) {
    return {
        async readFile(_ctx, id, path, { maxBytes }) {
            return new TextDecoder().decode(bytes(runtime, id, path).slice(-maxBytes));
        },
        async writeFile(_ctx, id, path, content) {
            ready(runtime, id).files.set(path, new TextEncoder().encode(content));
        },
        async listFiles(_ctx, id, path, { limit }) {
            const prefix = path.endsWith("/") ? path : `${path}/`;
            const result = new Map();
            for (const [name, content] of ready(runtime, id).files) {
                if (!name.startsWith(prefix))
                    continue;
                const relative = name.slice(prefix.length);
                const first = relative.split("/")[0];
                if (first)
                    result.set(first, {
                        name: first,
                        isDir: relative.includes("/"),
                        size: content.byteLength,
                    });
                if (result.size >= limit)
                    break;
            }
            return [...result.values()];
        },
        async upload(_ctx, id, path, content) {
            ready(runtime, id).files.set(path, new Uint8Array(content));
        },
        async download(_ctx, id, path, { maxBytes, offset = 0, totalSizeLimit = maxBytes }) {
            const content = bytes(runtime, id, path);
            if (content.byteLength > totalSizeLimit)
                throw new Error("SANDBOX_EXPORT_TOO_LARGE");
            return content.slice(offset, offset + maxBytes);
        },
    };
}
