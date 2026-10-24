import { expect, it } from "vite-plus/test";
import { convexTest } from "convex-test";
import { anyApi, type ApiFromModules } from "convex/server";
import daytonaTest from "@daytona/convex/test";
import schema from "./fixture/schema.js";
import type * as daytona from "./fixture/daytona.js";

const api = anyApi as unknown as ApiFromModules<{ daytona: typeof daytona }>;
const modules = import.meta.glob(["./fixture/daytona.ts", "./fixture/_generated/*.ts"]);

it.skipIf(!process.env.DAYTONA_API_KEY)(
  "live Daytona creates, executes, writes/reads, stops and always deletes the sandbox",
  async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    daytonaTest.register(t);
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
      }),
    );
  },
  180_000,
);
