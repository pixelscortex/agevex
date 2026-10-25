import { componentsGeneric, internalActionGeneric } from "convex/server";
import type { ComponentApi } from "@daytona/convex";
import type { AgentComponent } from "@convex-dev/agent";
import { v } from "convex/values";
import { daytona } from "../../../src/sandbox/daytona.js";
import { defineSandbox } from "../../../src/sandbox/index.js";
import type { ComponentApi as SandboxApi } from "../../../src/sandbox/component/_generated/component.js";

// Used only by the opt-in live configuration. The default suite never imports
// or runs this host function, and all actual API traffic goes through Daytona's
// component. API keys are resolved from the live process, never returned.
export const lifecycle = internalActionGeneric({
  args: {
    op: v.string(),
    sandboxId: v.optional(v.string()),
    job: v.optional(v.object({ jobId: v.string(), sandboxId: v.string(), directory: v.string() })),
  },
  handler: async (ctx, args) => {
    const provider = daytona(componentsGeneric()["daytona"] as unknown as ComponentApi, {
      autoStopInterval: 1,
    });
    if (args.op === "create") return provider.create(ctx, { scopeKey: crypto.randomUUID() });
    const sandboxId = args.sandboxId!;
    switch (args.op) {
      case "resume":
        await provider.resume(ctx, sandboxId);
        return null;
      case "exec":
        return provider.exec(ctx, sandboxId, "echo hi", {
          timeoutS: 10,
          signal: new AbortController().signal,
        });
      case "write":
        await provider.writeFile(ctx, sandboxId, "/tmp/agevex-live.txt", "agevex live file");
        return null;
      case "read":
        return provider.readFile(ctx, sandboxId, "/tmp/agevex-live.txt", { maxBytes: 1024 });
      case "background":
        return provider.startBackground(
          ctx,
          sandboxId,
          `(sleep 1; touch /tmp/agevex-descendant-marker) & python3 -c 'print("x" * 70000); print("FINAL live error")'; exit 7`,
        );
      case "descendantCheck":
        return provider.exec(ctx, sandboxId, "sleep 1.1; test ! -e /tmp/agevex-descendant-marker", {
          timeoutS: 10,
          signal: new AbortController().signal,
        });
      case "poll":
        return provider.poll(ctx, args.job!.jobId, args.job!);
      case "controlBackground":
      case "fallbackBackground":
        return provider.startBackground(ctx, sandboxId, "exec sleep 120");
      case "unmarkedBackground":
        return provider.startBackground(ctx, sandboxId, "exec env -u AGEVEX_JOB sleep 120");
      case "controlCancel":
      case "fallbackCancel":
      case "unmarkedCancel": {
        const job = args.job!;
        const directory = job.directory;
        const pgid = Number(
          await provider.readFile(ctx, sandboxId, `${directory}/group.pid`, { maxBytes: 256 }),
        );
        const supervisor = Number(
          await provider.readFile(ctx, sandboxId, `${directory}/supervisor.pid`, { maxBytes: 256 }),
        );
        const options = { timeoutS: 10, signal: new AbortController().signal };
        // The control path must work without a persisted PGID; fallback paths
        // must instead survive loss of their supervisor and inspect real /proc.
        const preparation = await provider.exec(
          ctx,
          sandboxId,
          args.op === "controlCancel" ? `rm ${directory}/group.pid` : `kill -9 ${supervisor}`,
          options,
        );
        if (preparation.exitCode !== 0) throw new Error("LIVE_CANCEL_PREPARATION_FAILED");
        await provider.cancelBackground(ctx, job.jobId, job);
        const cancellation = await provider.readFile(ctx, sandboxId, `${directory}/cancelled`, {
          maxBytes: 256,
        });
        const request = await provider.readFile(ctx, sandboxId, `${directory}/cancel.request`, {
          maxBytes: 256,
        });
        // Zombies are already terminated. Check the actual original group,
        // rather than only trusting the adapter's acknowledgement file.
        const inspection = await provider.exec(
          ctx,
          sandboxId,
          `python3 -c 'import os; active=[]\nfor entry in os.scandir("/proc"):\n if not entry.name.isdigit(): continue\n try:\n  if os.getpgid(int(entry.name))==${pgid}:\n   state=open("/proc/"+entry.name+"/stat").read().rsplit(")",1)[1].split()[0]\n   if state!="Z": active.append(entry.name)\n except ProcessLookupError: pass\nassert bool(active)==${args.op === "unmarkedCancel" ? "True" : "False"},active'`,
          options,
        );
        return {
          cancellation,
          request,
          inspection,
          outcome: await provider.poll(ctx, job.jobId, job),
        };
      }
      case "export": {
        await provider.exec(
          ctx,
          sandboxId,
          `python3 -c 'open("/tmp/agevex-large.bin","wb").write(bytes(i % 251 for i in range(3 * 1024 * 1024 + 17)))'`,
          { timeoutS: 10, signal: new AbortController().signal },
        );
        const component = componentsGeneric()["sandbox"] as unknown as SandboxApi;
        const sandbox = defineSandbox({
          component,
          provider,
          scope: "thread",
          agent: componentsGeneric()["agent"] as unknown as AgentComponent,
          authorize: async () => ({ subject: "live" }),
        });
        const scopeKey = await sandbox.scopeKey({
          subject: "live",
          threadId: "live",
          runId: "live",
        });
        const reserved = await ctx.runMutation(component.state.reserve, {
          scopeKey,
          provider: provider.id,
          ttl: sandbox.limits.ttl,
        });
        await ctx.runMutation(component.state.save, {
          scopeKey,
          claim: reserved.claim!,
          sandboxId,
          state: "ready",
        });
        return sandbox.export(ctx, { threadId: "live", path: "/tmp/agevex-large.bin" });
      }
      case "stop":
        await provider.stop(ctx, sandboxId);
        return null;
      case "delete":
        await provider.delete(ctx, sandboxId);
        return null;
      default:
        throw new Error("INVALID_LIVE_OPERATION");
    }
  },
});
