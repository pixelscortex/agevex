/** Binary write guarantees with the fake provider and enforced Convex transaction limits. */
import { expect, it } from "vite-plus/test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { LIMITS, HARD_LIMITS, SandboxWriteError } from "../../src/modules/sandbox/client/index.js";
import type { SandboxContext } from "../../src/modules/sandbox/client/types.js";
import { setup, api, state, EXPORT_TEST_TIMEOUT_MS } from "./setup.js";

const fixtureBytes = (size: number) => Uint8Array.from({ length: size }, (_, i) => i % 251);

const write = (s: ReturnType<typeof setup>, input: Record<string, unknown>) =>
  s.t.action(api.host.invoke, { op: "writeBytes", input });

const expected = (bytes: Uint8Array) => ({
  bytes: bytes.length,
  sha256: bytesToHex(sha256(bytes)),
});

it(
  "writes exactly 8 MiB through <=512 KiB windows and publishes exact bytes only at commit",
  async () => {
    const s = setup();
    const content = fixtureBytes(LIMITS.exportBytes);
    const original = s.fake.provider.writeWindow;
    const windows: number[] = [];

    s.fake.provider.writeWindow = async (ctx, id, path, offset, bytes) => {
      expect(s.fake.sandboxes.get(id)!.files.has("/max.bin")).toBe(false);
      expect(offset).toBe(windows.reduce((a, b) => a + b, 0));
      expect(bytes.length).toBeLessThanOrEqual(LIMITS.exportChunkBytes);
      windows.push(bytes.length);
      await original(ctx, id, path, offset, bytes);
    };

    expect(await write(s, { path: "/max.bin", source: { bytes: content.buffer } })).toEqual(
      expected(content),
    );

    expect(windows).toHaveLength(LIMITS.exportBytes / LIMITS.exportChunkBytes);
    expect(s.fake.sandboxes.get("fake-sandbox-1")!.files.get("/max.bin")).toEqual(content);
    expect([...s.fake.sandboxes.get("fake-sandbox-1")!.files.keys()]).toEqual(["/max.bin"]);
  },
  EXPORT_TEST_TIMEOUT_MS,
);

it(
  "interruption leaves no partial target and retry with the same bytes completes",
  async () => {
    const s = setup();
    const content = fixtureBytes(3 * LIMITS.exportChunkBytes + 17);
    const original = s.fake.provider.writeWindow;
    let fail = true;

    s.fake.provider.writeWindow = async (...args) => {
      if (fail && args[3] === LIMITS.exportChunkBytes) throw new Error("TRANSFER_INTERRUPTED");

      return original(...args);
    };

    const input = { path: "/retry.bin", source: { bytes: content.buffer }, toolContext: true };

    await expect(write(s, input)).rejects.toThrow("TRANSFER_INTERRUPTED");
    expect(s.fake.sandboxes.get("fake-sandbox-1")!.files.size).toBe(0);
    fail = false;
    expect(await write(s, input)).toEqual(expected(content));
    expect(s.fake.sandboxes.get("fake-sandbox-1")!.files.get(input.path)).toEqual(content);
  },
  EXPORT_TEST_TIMEOUT_MS,
);

it(
  "interrupted replacement preserves the original and keeps a fresh abandoned stage until it is stale",
  async () => {
    const s = setup();

    await write(s, { path: "/replace", source: { bytes: new Uint8Array([9]).buffer } });
    const content = fixtureBytes(LIMITS.exportChunkBytes + 1);
    const original = s.fake.provider.writeWindow;
    const discard = s.fake.provider.discardWrite;

    s.fake.provider.discardWrite = async () => {
      // Model process death during cleanup: leave the stage for a later call.
      throw new Error("PROCESS_DIED");
    };

    s.fake.provider.writeWindow = async (...args) => {
      if (args[3] > 0) throw new Error("TRANSFER_INTERRUPTED");

      return original(...args);
    };

    await expect(write(s, { path: "/replace", source: { bytes: content.buffer } })).rejects.toThrow(
      "TRANSFER_INTERRUPTED",
    );

    const machine = s.fake.sandboxes.get("fake-sandbox-1")!;
    const files = machine.files;

    expect(files.get("/replace")).toEqual(new Uint8Array([9]));
    expect(files.size).toBe(2);
    s.fake.provider.discardWrite = discard;
    s.fake.provider.writeWindow = original;

    // The stranded stage may belong to a live writer, so a fresh one survives.
    await write(s, { path: "/replace", source: { bytes: content.buffer } });
    expect(files.size).toBe(2);
    expect(files.get("/replace")).toEqual(content);

    // Once it is older than the staleness threshold, the next write reclaims it.
    for (const path of machine.touched.keys()) machine.touched.set(path, 0);

    await write(s, { path: "/replace", source: { bytes: content.buffer } });
    expect([...files.keys()]).toEqual(["/replace"]);
    expect(files.get("/replace")).toEqual(content);
  },
  EXPORT_TEST_TIMEOUT_MS,
);

it(
  "overlapping writes to one path never disturb each other's stage and the target is exactly one source",
  async () => {
    const s = setup();
    const first = fixtureBytes(2 * LIMITS.exportChunkBytes + 5);
    const second = first.map((byte) => 255 - byte).subarray(0, LIMITS.exportChunkBytes + 9);
    const original = s.fake.provider.writeWindow;
    let release!: () => void;
    let parked!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (parked = resolve));
    let firstStage: string | undefined;

    await write(s, { path: "/race", source: { bytes: new Uint8Array([7]).buffer } });

    s.fake.provider.writeWindow = async (ctx, id, path, offset, bytes) => {
      await original(ctx, id, path, offset, bytes);

      // Park the first writer after its first window, while its stage is live.
      if (firstStage === undefined) {
        firstStage = path;
        parked();
        await gate;
      }
    };

    const slow = write(s, { path: "/race", source: { bytes: first.buffer } });

    await reached;

    expect(await write(s, { path: "/race", source: { bytes: second.slice().buffer } })).toEqual(
      expected(second),
    );

    const files = s.fake.sandboxes.get("fake-sandbox-1")!.files;

    expect(files.get("/race")).toEqual(second);
    expect(files.has(firstStage!)).toBe(true);
    release();
    expect(await slow).toEqual(expected(first));

    // Last committed writer wins, byte for byte, and no stage is left behind.
    expect(files.get("/race")).toEqual(first);
    expect([...files.keys()]).toEqual(["/race"]);
  },
  EXPORT_TEST_TIMEOUT_MS,
);

it("typed write failures are observed as definite, other failures stay unknown", async () => {
  const s = setup();
  const original = s.fake.provider.writeWindow;
  const input = { path: "/usage", source: { bytes: new Uint8Array([1]).buffer } };

  s.fake.provider.writeWindow = async () => {
    throw new SandboxWriteError("SANDBOX_WRITE_OFFSET_MISMATCH");
  };

  await expect(write(s, input)).rejects.toThrow("SANDBOX_WRITE_OFFSET_MISMATCH");

  s.fake.provider.writeWindow = async () => {
    throw new Error("TRANSFER_INTERRUPTED");
  };

  await expect(write(s, input)).rejects.toThrow("TRANSFER_INTERRUPTED");
  s.fake.provider.writeWindow = original;

  expect(
    state.usage.filter((event) => event.operation === "write").map((event) => event.outcome),
  ).toEqual(["observed", "unknown"]);
});

it("duplicate windows at the same offset are no-ops, including duplicates before later windows", async () => {
  const { provider, ctx, files, id } = await prepared();

  await provider.writeWindow(ctx, id, "/stage", 0, new Uint8Array([1, 2]));
  await provider.writeWindow(ctx, id, "/stage", 2, new Uint8Array([3, 4]));
  await provider.writeWindow(ctx, id, "/stage", 0, new Uint8Array([1, 2]));
  await provider.writeWindow(ctx, id, "/stage", 2, new Uint8Array([3, 4]));
  expect(files.get("/stage")).toEqual(new Uint8Array([1, 2, 3, 4]));
});

it("gaps, partial overlaps and conflicting duplicate bytes produce a typed offset error", async () => {
  const { provider, ctx, files, id } = await prepared();

  await provider.writeWindow(ctx, id, "/stage", 0, new Uint8Array([1, 2]));

  for (const [offset, bytes] of [
    [3, [3]],
    [1, [2, 3]],
    [0, [9]],
  ] as const) {
    await expect(
      provider.writeWindow(ctx, id, "/stage", offset, new Uint8Array(bytes)),
    ).rejects.toMatchObject({
      code: "SANDBOX_WRITE_OFFSET_MISMATCH",
      name: "SandboxWriteError",
    });
  }

  expect(files.get("/stage")).toEqual(new Uint8Array([1, 2]));
});

it("commit refuses incomplete or corrupt bytes without changing the target", async () => {
  const { provider, ctx, files, id } = await prepared();

  files.set("/target", new Uint8Array([9]));
  await provider.writeWindow(ctx, id, "/stage", 0, new Uint8Array([1, 2]));

  for (const content of [new Uint8Array([1]), new Uint8Array([1, 3])])
    await expect(
      provider.commitWrite(ctx, id, "/stage", "/target", expected(content)),
    ).rejects.toBeInstanceOf(SandboxWriteError);

  expect(files.get("/target")).toEqual(new Uint8Array([9]));
});

it(
  "storageId sources write exact binary bytes across multiple windows",
  async () => {
    const s = setup();
    const content = fixtureBytes(3 * LIMITS.exportChunkBytes + 17);
    const storageId = await s.t.run((ctx) => ctx.storage.store(new Blob([content])));

    expect(await write(s, { path: "/storage.bin", source: { storageId } })).toEqual(
      expected(content),
    );

    expect(s.fake.sandboxes.get("fake-sandbox-1")!.files.get("/storage.bin")).toEqual(content);
  },
  EXPORT_TEST_TIMEOUT_MS,
);

it(
  "default runtime refuses bytes and storage sources above 8 MiB before provider work",
  async () => {
    const s = setup();
    const content = new Uint8Array(LIMITS.exportBytes + 1);
    const storageId = await s.t.run((ctx) => ctx.storage.store(new Blob([content])));

    for (const source of [{ bytes: content.buffer }, { storageId }])
      await expect(write(s, { path: "/too-big", source })).rejects.toThrow(
        "SANDBOX_WRITE_TOO_LARGE",
      );

    expect(s.fake.calls.create).toBe(0);
  },
  EXPORT_TEST_TIMEOUT_MS,
);

it("maxBytes and path validation refuse invalid writes before provider work", async () => {
  const s = setup();

  for (const maxBytes of [1, -1, 0.5, LIMITS.exportBytes + 1])
    await expect(
      write(s, { path: "/bounded", source: { bytes: new Uint8Array([1, 2]).buffer }, maxBytes }),
    ).rejects.toThrow("SANDBOX_");

  for (const path of ["", "bad\0path", "x".repeat(LIMITS.pathChars + 1)])
    await expect(write(s, { path, source: { bytes: new Uint8Array().buffer } })).rejects.toThrow(
      "SANDBOX_INVALID_PATH",
    );

  expect(s.fake.calls.create).toBe(0);
});

it("host policy and subject isolation gate binary writes before provider work", async () => {
  const s = setup();

  state.authorized = false;

  await expect(
    write(s, { path: "/denied", source: { bytes: new Uint8Array([1]).buffer } }),
  ).rejects.toThrow("HOST_DENIED");

  expect(s.fake.calls.create).toBe(0);
  state.authorized = true;
  await write(s, { path: "/shared", source: { bytes: new Uint8Array([1]).buffer } });

  await s.t.action(api.host.invoke, {
    op: "writeBytes",
    input: { path: "/shared", source: { bytes: new Uint8Array([2]).buffer } },
    subject: "other",
  });

  expect(s.fake.sandboxes.get("fake-sandbox-1")!.files.get("/shared")).toEqual(new Uint8Array([1]));
  expect(s.fake.sandboxes.get("fake-sandbox-2")!.files.get("/shared")).toEqual(new Uint8Array([2]));
});

it("empty bytes atomically replace an existing target with an empty file", async () => {
  const s = setup();

  await write(s, { path: "/empty", source: { bytes: new Uint8Array([1]).buffer } });
  const content = new Uint8Array();

  expect(
    await write(s, { path: "/empty", source: { bytes: content.buffer }, maxBytes: 0 }),
  ).toEqual(expected(content));

  expect(s.fake.sandboxes.get("fake-sandbox-1")!.files.get("/empty")).toEqual(content);
});

it("retry after a lost commit acknowledgement safely replaces the target with the same bytes", async () => {
  const s = setup();
  const commit = s.fake.provider.commitWrite;

  s.fake.provider.commitWrite = async (...args) => {
    await commit(...args);
    throw new Error("LOST_COMMIT_RESPONSE");
  };

  const content = fixtureBytes(17);
  const input = { path: "/committed", source: { bytes: content.buffer } };

  await expect(write(s, input)).rejects.toThrow("LOST_COMMIT_RESPONSE");
  expect(s.fake.sandboxes.get("fake-sandbox-1")!.files.get(input.path)).toEqual(content);
  s.fake.provider.commitWrite = commit;
  expect(await write(s, input)).toEqual(expected(content));
});

it(
  "Node storage writes accept the 64 MiB hard maximum in windows and refuse larger files",
  async () => {
    const s = setup();

    state.nodeWrite = true;
    const content = new Uint8Array(HARD_LIMITS.exportBytesNode);

    content[content.length - 1] = 251;
    const storageId = await s.t.run((ctx) => ctx.storage.store(new Blob([content])));
    const original = s.fake.provider.writeWindow;

    s.fake.provider.writeWindow = async (...args) => {
      expect(args[4].length).toBeLessThanOrEqual(LIMITS.exportChunkBytes);

      return original(...args);
    };

    expect(await write(s, { path: "/node-max", source: { storageId } })).toEqual(expected(content));

    expect(expected(s.fake.sandboxes.get("fake-sandbox-1")!.files.get("/node-max")!)).toEqual(
      expected(content),
    );

    const tooLarge = await s.t.run((ctx) =>
      ctx.storage.store(new Blob([content, new Uint8Array([1])])),
    );

    await expect(write(s, { path: "/node-over", source: { storageId: tooLarge } })).rejects.toThrow(
      "SANDBOX_WRITE_TOO_LARGE",
    );
  },
  EXPORT_TEST_TIMEOUT_MS,
);

it(
  "typed write errors keep their code when a large write runs in the Node action",
  async () => {
    const s = setup();

    state.nodeWrite = true;
    const content = new Uint8Array(LIMITS.exportBytes + 1);
    const storageId = await s.t.run((ctx) => ctx.storage.store(new Blob([content])));

    s.fake.provider.writeWindow = async () => {
      throw new SandboxWriteError("SANDBOX_WRITE_OFFSET_MISMATCH");
    };

    await expect(write(s, { path: "/node-typed", source: { storageId } })).rejects.toMatchObject({
      name: "SandboxWriteError",
      code: "SANDBOX_WRITE_OFFSET_MISMATCH",
    });
  },
  EXPORT_TEST_TIMEOUT_MS,
);

/** Prepare through the authorized API; direct calls below test provider guarantees. */
async function prepared() {
  const s = setup();

  await s.t.action(api.host.invoke, { op: "prepare", input: {} });

  return {
    provider: s.fake.provider,
    ctx: {} as SandboxContext,
    files: s.fake.sandboxes.get("fake-sandbox-1")!.files,
    id: "fake-sandbox-1",
  };
}
