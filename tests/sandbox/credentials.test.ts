import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ComponentApi } from "@daytona/convex";
import { daytona } from "../../src/modules/sandbox/client/daytona.js";
import type { SandboxContext } from "../../src/modules/sandbox/client/types.js";

// The SDK forwards `config.apiKey` to the component on every call, so the
// recorded action arguments show exactly which key a Daytona call carried.
function harness(state: "started" | "error" = "started") {
  const runAction = vi.fn(async (ref: string) => {
    if (ref === "create") return { sandboxId: "sb-1" };

    if (ref === "refresh") return { state };

    return null;
  });

  const ctx = { runAction } as unknown as SandboxContext;

  const component = {
    sandboxes: { create: "create", refresh: "refresh", start: "start" },
  } as unknown as ComponentApi;

  return { ctx, component, runAction };
}

const keyOf = (call: unknown[]) => (call[1] as { config: { apiKey: string } }).config.apiKey;

afterEach(() => {
  vi.restoreAllMocks();
});

it("a lazy Daytona key is resolved on each call, not at construction, and travels with the call", async () => {
  const { ctx, component, runAction } = harness();
  const apiKey = vi.fn(async () => "lazy-key");
  const provider = daytona(component, { apiKey });

  expect(apiKey).not.toHaveBeenCalled();

  await provider.create(ctx, { scopeKey: "scope" });
  expect(apiKey).toHaveBeenCalledTimes(1);
  expect(keyOf(runAction.mock.calls[0])).toBe("lazy-key");
});

it("a plain Daytona key string still works unchanged", async () => {
  const { ctx, component, runAction } = harness();

  await daytona(component, { apiKey: "plain-key" }).create(ctx, { scopeKey: "scope" });
  expect(keyOf(runAction.mock.calls[0])).toBe("plain-key");
});

it("an empty lazy Daytona key fails with SANDBOX_DAYTONA_KEY_REQUIRED before any provider call", async () => {
  const { ctx, component, runAction } = harness();
  const provider = daytona(component, { apiKey: () => "" });

  await expect(provider.create(ctx, { scopeKey: "scope" })).rejects.toThrow(
    "SANDBOX_DAYTONA_KEY_REQUIRED",
  );

  expect(runAction).not.toHaveBeenCalled();
});

it("error-state recovery uses the lazily resolved key as its REST bearer", async () => {
  const { ctx, component } = harness("error");
  const request = vi.fn(async () => new Response(null, { status: 503 }));

  vi.spyOn(globalThis, "fetch").mockImplementation(request);

  const provider = daytona(component, { apiKey: async () => "recover-key" });

  await expect(provider.resume(ctx, "sb-1")).rejects.toThrow("SANDBOX_RECOVERY_UNAVAILABLE");

  expect(request.mock.calls[0]).toMatchObject([
    expect.any(String),
    { headers: { Authorization: "Bearer recover-key" } },
  ]);

  const empty = daytona(component, { apiKey: () => "" });

  await expect(empty.resume(ctx, "sb-1")).rejects.toThrow("SANDBOX_DAYTONA_KEY_REQUIRED");
  expect(request).toHaveBeenCalledTimes(1);
});
