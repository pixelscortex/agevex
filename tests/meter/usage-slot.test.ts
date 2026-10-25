import { createHash } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { LIMITS } from "../../src/meter/index.js";
import { setup, attribution } from "./setup.js";

const facts = {
  subject: attribution.subject,
  rootThreadId: attribution.rootThreadId,
  threadId: attribution.threadId,
  runId: attribution.runId,
  agent: attribution.agent,
};
const cost = { openrouter: { usage: { cost: 0.1 } } };

it("the usage slot prices an AI SDK provider id such as openrouter.chat under its registered name", async () => {
  const { t, meter, component } = setup();
  await t.action(async (ctx) => {
    // @openrouter/ai-sdk-provider 3.1.0 stores this id as message.provider.
    await meter
      .usageSlot()
      .scope(ctx, { ...facts, model: "model" })
      .record("openrouter.chat", { key: "sdk-id", providerMetadata: cost });
    await meter
      .usageSlot({ providers: { router: "openrouter" } })
      .scope(ctx, { ...facts, model: "model" })
      .record("router", { key: "mapped", providerMetadata: cost });
  });
  for (const key of ["sdk-id", "mapped"])
    expect(await t.query(component.charges.get, { key })).toMatchObject({
      status: "settled",
      provider: "openrouter",
      nanos: 100_000_000,
    });
  expect(() => meter.usageSlot({ providers: { router: "missing" } })).toThrow(
    "PROVIDER_NOT_REGISTERED",
  );
});

it("slot recording and budget checks skip host authorize while host-facing reads keep it", async () => {
  const { t, meter, component } = setup({
    // A typical host guard: requires a signed-in user. Core's background
    // slot calls have no user identity.
    authorize: async (ctx) => {
      if (!(await ctx.auth.getUserIdentity())) throw new Error("UNAUTHENTICATED");
    },
  });
  const allowed = await t.action(async (ctx) => {
    const charge = await meter
      .usageSlot()
      .scope(ctx, { ...facts, model: "model" })
      .estimate("fal", { key: "managed", profile: "image", quantity: 1 });
    await charge.settle({ usd: 0.2, key: "settle" });
    return (await meter.budgetSlot().check(ctx, { subject: facts.subject, runId: facts.runId }))
      .allowed;
  });
  expect(allowed).toBe(true);
  expect(await t.query(component.charges.get, { key: "managed" })).toMatchObject({
    status: "settled",
  });
  await expect(t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).rejects.toThrow(
    "UNAUTHENTICATED",
  );
  await expect(
    t.run((ctx) => meter.check(ctx, { subject: facts.subject, runId: facts.runId })),
  ).rejects.toThrow("UNAUTHENTICATED");
});

it("a model id over the label limit is recorded as a sha256 label instead of dropping the charge", async () => {
  const { t, meter, component } = setup();
  const model = "provider/" + "m".repeat(LIMITS.maxStringBytes);
  await t.action(async (ctx) => {
    await meter
      .usageSlot()
      .scope(ctx, { ...facts, model })
      .record("openrouter", { key: "long-model", providerMetadata: cost });
  });
  const charge = await t.query(component.charges.get, { key: "long-model" });
  expect(charge).toMatchObject({
    status: "settled",
    attribution: { model: `sha256:${createHash("sha256").update(model).digest("hex")}` },
  });
  expect(JSON.stringify(charge)).not.toContain(model);
});
