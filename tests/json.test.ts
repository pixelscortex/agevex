/** Pin identities recorded before helper consolidation and preserve byte guards. */
import { expect, it } from "vite-plus/test";
import { getConvexSize } from "convex/values";
import { fingerprint, opaqueKey } from "../src/client/keys.js";
import { valueBytes } from "../src/shared/json.js";

it("keeps canonical fingerprints and receipt keys byte-identical", async () => {
  expect(await fingerprint(null)).toBe(
    "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
  );

  const hash = "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777";

  expect(await fingerprint({ b: 2, a: 1 })).toBe(hash);
  expect(await fingerprint({ a: 1, b: 2 })).toBe(hash);

  expect(await fingerprint(["☃", { z: [3, 2], a: true }])).toBe(
    "9d11e62a0831ad2894f674b52d139215afb6a7961b72946fddde6a614775399f",
  );

  expect(await opaqueKey("effect", "thread:1", "call:1")).toBe(
    "bba48eb32093dc1a658a75bdf9a0d77be022757a99c70410ab3762401abab288",
  );
});

it("bounds both encodings, including escaped strings and bigint run metadata", () => {
  for (const value of ["\n".repeat(30), "☃".repeat(30), { count: 1234567890123456789n }]) {
    const json = JSON.stringify(value, (_key, part) =>
      typeof part === "bigint" ? part.toString() : part,
    );

    expect(valueBytes(value)).toBe(
      Math.max(getConvexSize(value), new TextEncoder().encode(json).length),
    );
  }

  expect(valueBytes("\n".repeat(30))).toBeGreaterThan(
    new TextEncoder().encode("\n".repeat(30)).length,
  );
});
