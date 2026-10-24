import { componentsGeneric, internalActionGeneric } from "convex/server";
import type { ComponentApi } from "@daytona/convex";
import { v } from "convex/values";
import { daytona } from "../../../src/sandbox/daytona.js";

// Used only by the opt-in live configuration. The default suite never imports
// or runs this host function, and all actual API traffic goes through Daytona's
// component. API keys are resolved from the live process, never returned.
export const lifecycle = internalActionGeneric({
  args: { op: v.string(), sandboxId: v.optional(v.string()) },
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
