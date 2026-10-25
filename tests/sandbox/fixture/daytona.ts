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
          `python3 -c 'print("x" * 70000); print("FINAL live error")'; exit 7`,
        );
      case "poll":
        return provider.poll(ctx, args.job!.jobId, args.job!);
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
