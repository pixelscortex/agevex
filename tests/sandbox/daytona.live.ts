import { expect, it } from "vite-plus/test";
import { convexTest, type TestConvex } from "convex-test";
import { anyApi, type ApiFromModules } from "convex/server";
import daytonaTest from "@daytona/convex/test";
import agentTest from "@convex-dev/agent/test";
import sandboxTest from "../../src/modules/sandbox/test.js";
import type { BackgroundJob } from "../../src/modules/sandbox/client/types.js";
import schema from "./fixture/schema.js";
import type * as daytona from "./fixture/daytona.js";

const api = anyApi as unknown as ApiFromModules<{ daytona: typeof daytona }>;

type Test = TestConvex<typeof schema>;

const modules = import.meta.glob(["./fixture/daytona.ts", "./fixture/_generated/*.ts"]);

it.skipIf(!process.env.DAYTONA_API_KEY)(
  "live Daytona enforces process cleanup, cancellation and binary write/export round-trips, and always deletes the sandbox",
  async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });

    daytonaTest.register(t);
    agentTest.register(t);
    sandboxTest.register(t);
    let sandboxId: string | undefined;
    let writeTimingMs = 0;
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

      await expectBackgroundLifecycle(t, sandboxId);

      writeTimingMs = await expectBinaryTransfers(t, sandboxId);

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
        controlFileCancel: true,
        fallbackMarkerVerified: true,
        unmarkedGroupPreserved: true,
        exportBytes: 3 * 1024 * 1024 + 17,
        writeRoundTripBytes: 3 * 512 * 1024 + 17,
        write8MiBMs: writeTimingMs,
      }),
    );
  },
  300_000,
);

/** Live process control checks use the same sandbox throughout. */
async function expectBackgroundLifecycle(t: Test, sandboxId: string) {
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

  expect(await t.action(api.daytona.lifecycle, { op: "descendantCheck", sandboxId })).toMatchObject(
    { exitCode: 0 },
  );

  for (const mode of ["control", "fallback", "unmarked"]) {
    const cancellationJob = (await t.action(api.daytona.lifecycle, {
      op: `${mode}Background`,
      sandboxId,
    })) as BackgroundJob;

    expect(
      await t.action(api.daytona.lifecycle, {
        op: `${mode}Cancel`,
        sandboxId,
        job: cancellationJob,
      }),
    ).toMatchObject({
      cancellation: mode === "unmarked" ? "unknown" : "deadline",
      request: "deadline\n",
      inspection: { exitCode: 0 },
      outcome: { state: "unknown" },
    });
  }
}

/** Byte integrity, storage size and timing share one transfer setup. */
async function expectBinaryTransfers(t: Test, sandboxId: string) {
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

  const roundTrip = (await t.action(api.daytona.lifecycle, {
    op: "writeRoundTrip",
    sandboxId,
  })) as {
    written: { bytes: number; sha256: string };
    exported: { bytes: number; sha256: string; storageId: string };
  };

  const writtenBytes = Uint8Array.from({ length: 3 * 512 * 1024 + 17 }, (_, i) => i % 251);

  expect(roundTrip.written).toEqual({
    bytes: writtenBytes.length,
    sha256: Buffer.from(await crypto.subtle.digest("SHA-256", writtenBytes)).toString("hex"),
  });

  expect(roundTrip.exported).toMatchObject(roundTrip.written);

  const storedBytes = new Uint8Array(
    await t.run(async (ctx) =>
      (await ctx.storage.get(roundTrip.exported.storageId as never))!.arrayBuffer(),
    ),
  );

  expect(storedBytes).toEqual(writtenBytes);

  const timing = (await t.action(api.daytona.lifecycle, {
    op: "writeTiming",
    sandboxId,
  })) as { written: { bytes: number }; elapsedMs: number };

  expect(timing.written.bytes).toBe(8 * 1024 * 1024);

  return timing.elapsedMs;
}
