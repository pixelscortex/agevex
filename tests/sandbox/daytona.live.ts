import { expect, it } from "vite-plus/test";
import { convexTest } from "convex-test";
import { anyApi, type ApiFromModules } from "convex/server";
import daytonaTest from "@daytona/convex/test";
import agentTest from "@convex-dev/agent/test";
import sandboxTest from "../../src/sandbox/test.js";
import type { BackgroundJob } from "../../src/sandbox/types.js";
import schema from "./fixture/schema.js";
import type * as daytona from "./fixture/daytona.js";

const api = anyApi as unknown as ApiFromModules<{ daytona: typeof daytona }>;
const modules = import.meta.glob(["./fixture/daytona.ts", "./fixture/_generated/*.ts"]);

it.skipIf(!process.env.DAYTONA_API_KEY)(
  "live Daytona terminates background descendants, preserves the log tail, exports below 8 MiB, and always deletes the sandbox",
  async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    daytonaTest.register(t);
    agentTest.register(t);
    sandboxTest.register(t);
    let sandboxId: string | undefined;
    const started = Date.now();
    try {
      const created = (await t.action(api.daytona.lifecycle, { op: "create" })) as {
        sandboxId: string;
      };
      sandboxId = created.sandboxId;
      await t.action(api.daytona.lifecycle, { op: "resume", sandboxId });
      expect(await t.action(api.daytona.lifecycle, { op: "exec", sandboxId })).toMatchObject({
        exitCode: 0,
        stdout: "hi\n",
        stderr: "",
      });
      await t.action(api.daytona.lifecycle, { op: "write", sandboxId });
      expect(await t.action(api.daytona.lifecycle, { op: "read", sandboxId })).toBe(
        "agevex live file",
      );
      const job = (await t.action(api.daytona.lifecycle, {
        op: "background",
        sandboxId,
      })) as BackgroundJob;
      await expect
        .poll(() => t.action(api.daytona.lifecycle, { op: "poll", sandboxId, job }), {
          timeout: 30_000,
          interval: 1000,
        })
        .toMatchObject({
          state: "failed",
          exitCode: 7,
          logTail: expect.stringContaining("FINAL live error"),
        });
      expect(
        await t.action(api.daytona.lifecycle, { op: "descendantCheck", sandboxId }),
      ).toMatchObject({ exitCode: 0 });
      const exported = (await t.action(api.daytona.lifecycle, { op: "export", sandboxId })) as {
        bytes: number;
        sha256: string;
        storageId: string;
      };
      const expected = Uint8Array.from({ length: 3 * 1024 * 1024 + 17 }, (_, i) => i % 251);
      expect(exported).toMatchObject({
        bytes: expected.length,
        sha256: Buffer.from(await crypto.subtle.digest("SHA-256", expected)).toString("hex"),
      });
      expect(exported.bytes).toBeLessThan(8 * 1024 * 1024);
      expect(
        await t.run(async (ctx) => (await ctx.storage.get(exported.storageId as never))!.size),
      ).toBe(expected.length);
      await t.action(api.daytona.lifecycle, { op: "stop", sandboxId });
    } finally {
      // Deletion is never conditional on any assertion or previous lifecycle
      // operation succeeding. No live sandbox is intentionally left running.
      if (sandboxId) await t.action(api.daytona.lifecycle, { op: "delete", sandboxId });
    }
    console.log(
      JSON.stringify({
        provider: "daytona",
        elapsedMs: Date.now() - started,
        deleted: true,
        model: null,
        tokens: 0,
        credits: 0,
        cost: "not reported by provider",
        backgroundLogBytes: 70000,
        descendantTerminated: true,
        exportBytes: 3 * 1024 * 1024 + 17,
      }),
    );
  },
  180_000,
);
