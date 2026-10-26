/**
 * Daytona lifecycle adapter operations.
 * The host provider factory binds these to one SDK client and validated settings.
 * Bounds are enforced inside the sandbox before data crosses Convex boundaries.
 */
import { type SandboxProvider } from "./types.js";
import { type DaytonaContext } from "./daytona-context.js";
import { LIMITS, bounded } from "../shared/limits.js";
import { type CreateSandboxArgs } from "@daytona/convex";

/** Bind create to the provider client; retain its source-side bounds and effect policy. */
export function buildCreate(runtime: DaytonaContext): SandboxProvider["create"] {
  const { client, opts, autoStopInterval, autoArchiveInterval } = runtime;

  const operation: Pick<SandboxProvider, "create"> = {
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

      const created = await (await client()).createSandbox(ctx, args);

      return { sandboxId: created.sandboxId };
    },
  };

  return operation.create;
}

/** Bind resume to the provider client; retain its source-side bounds and effect policy. */
export function buildResume(runtime: DaytonaContext): SandboxProvider["resume"] {
  const { client, opts } = runtime;

  const operation: Pick<SandboxProvider, "resume"> = {
    async resume(ctx, sandboxId) {
      const known = await (await client()).refreshSandbox(ctx, { sandboxId });

      if (!known || known.state === "destroyed") throw new Error("SANDBOX_GONE");

      if (known.state === "error") {
        // Narrow bridge matching the SDK's recover route. Confirm recoverable
        // first; never delete/recreate to hide an error and lose the files.
        const apiKey = await runtime.apiKey();

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

      await (await client()).startSandbox(ctx, { sandboxId, waitTimeoutMs: LIMITS.daytonaReadyMs });
    },
  };

  return operation.resume;
}

/** Bind stop to the provider client; retain its source-side bounds and effect policy. */
export function buildStop(runtime: DaytonaContext): SandboxProvider["stop"] {
  const { client } = runtime;

  const operation: Pick<SandboxProvider, "stop"> = {
    async stop(ctx, sandboxId) {
      await (await client()).stopSandbox(ctx, { sandboxId, waitTimeoutMs: LIMITS.daytonaReadyMs });
    },
  };

  return operation.stop;
}

/** Bind delete to the provider client; retain its source-side bounds and effect policy. */
export function buildDelete(runtime: DaytonaContext): SandboxProvider["delete"] {
  const { client } = runtime;

  const operation: Pick<SandboxProvider, "delete"> = {
    async delete(ctx, sandboxId) {
      await (await client()).deleteSandbox(ctx, { sandboxId });
    },
  };

  return operation.delete;
}
