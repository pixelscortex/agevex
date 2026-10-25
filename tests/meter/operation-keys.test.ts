import { expect, it } from "vite-plus/test";
import { LIMITS, type Charge } from "../../src/meter/index.js";
import { setup, attribution } from "./setup.js";

it.each([
  ["correct", { quantity: 3 }],
  ["attach", { requestId: "request" }],
  ["settle", { usd: 0.5 }],
  ["settle", { credits: 3 }],
] as const)(
  "%s rejects omitted or invalid operation keys from untyped callers",
  async (method, args) => {
    const { t, meter } = setup();

    await t.run(async (ctx) => {
      const charge = await meter.scope(ctx, attribution).estimate("fal", {
        key: "validation",
        profile: "image",
        quantity: 4,
      });

      const before = await charge.get();

      for (const key of [undefined, null, "", 42, true, [], {}, "é".repeat(LIMITS.maxKeyBytes)]) {
        // Reflect simulates JavaScript callers without weakening the typed API.
        await expect(Reflect.apply(charge[method], charge, [{ ...args, key }])).rejects.toThrow(
          "INVALID_OPERATION_KEY",
        );
      }

      await expect(Reflect.apply(charge[method], charge, [args])).rejects.toThrow(
        "INVALID_OPERATION_KEY",
      );

      expect(await charge.get()).toEqual(before);
    });
  },
);

it("attachment and settlement replay their original outcomes after later charge changes", async () => {
  const { t, meter } = setup();

  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("fal", {
      key: "outcomes",
      profile: "image",
      quantity: 4,
    });

    const attached = await charge.attach({ requestId: "request", key: "attach" });
    const corrected = await charge.correct({ quantity: 3, key: "correct" });
    const settled = await charge.settle({ usd: 0.5, key: "settle" });

    await charge.correct({ quantity: 1, key: "after-settlement" });
    const before = await charge.get();

    expect(await charge.attach({ requestId: "different", key: "attach" })).toEqual(attached);
    expect(await charge.correct({ quantity: 2, key: "correct" })).toEqual(corrected);
    expect(await charge.settle({ usd: 0.9, key: "settle" })).toEqual(settled);
    // Keys share a charge-wide namespace, even if a caller changes method.
    expect(await charge.settle({ usd: 1, key: "attach" })).toEqual(attached);
    expect(await charge.get()).toEqual(before);
  });
});

it("operation capacity rejects new keys while preserving the oldest replay and final amount", async () => {
  const { t, meter, component } = setup();
  let original: Charge | undefined;

  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("fal", {
      key: "capacity",
      profile: "image",
      quantity: 4,
    });

    original = await charge.correct({ quantity: 3, key: "oldest" });

    for (let index = 1; index < LIMITS.maxOperations; index++)
      await charge.correct({ quantity: 2, key: String(index).padEnd(LIMITS.maxKeyBytes, "x") });
  });

  const before = await t.query(component.charges.get, { key: "capacity" });

  expect(before).toMatchObject({ quantity: 2, nanos: 500_000_000 });

  for (const method of ["correct", "attach", "settle"] as const) {
    await expect(
      t.run(async (ctx) => {
        const charge = await meter.scope(ctx, attribution).estimate("fal", {
          key: "capacity",
          profile: "image",
          quantity: 4,
        });

        if (method === "correct") await charge.correct({ quantity: 4, key: "overflow" });

        if (method === "attach") await charge.attach({ requestId: "request", key: "overflow" });

        if (method === "settle") await charge.settle({ usd: 0.75, key: "overflow" });
      }),
    ).rejects.toThrow("OPERATION_CAPACITY");
  }

  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("fal", {
      key: "capacity",
      profile: "image",
      quantity: 4,
    });

    expect(await charge.correct({ quantity: 3, key: "oldest" })).toEqual(original);
  });

  expect(await t.query(component.charges.get, { key: "capacity" })).toEqual(before);

  expect(await t.run((ctx) => meter.subjectCost(ctx, { subject: "owner" }))).toMatchObject({
    totalNanos: 500_000_000,
  });
});
