import { it, expect } from "vite-plus/test";
import * as sdk from "../src/client/index.js";

it("Workflow byte ceilings are documented platform facts rather than configurable runtime limits", () => {
  expect(sdk).toHaveProperty(
    "PLATFORM",
    expect.objectContaining({ journalBytes: 8 << 20, stepBytes: 800 << 10 }),
  );
  expect(sdk.LIMITS).not.toHaveProperty("journalBytes");
  expect(sdk.LIMITS).not.toHaveProperty("stepBytes");
  expect(sdk.LIMITS).not.toHaveProperty("delegationPage");
});

it("live test spending and output caps never enter runtime limits", () => {
  expect(sdk.LIMITS).not.toHaveProperty("liveMaxUsd");
  expect(sdk.LIMITS).not.toHaveProperty("liveRequests");
  expect(sdk.LIMITS).not.toHaveProperty("liveOutputTokens");
});
