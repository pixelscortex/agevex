/** A server consumer must be able to import core with React unavailable. */
import { expect, it, vi } from "vite-plus/test";

vi.mock("react", () => {
  throw new Error("SERVER_MUST_NOT_LOAD_REACT");
});

vi.mock("convex/react", () => {
  throw new Error("SERVER_MUST_NOT_LOAD_CONVEX_REACT");
});

it("server core loads without React", async () => {
  const { Agent, registerAgent } = await import("../../src/client/index.js");

  expect(Agent).toBeTypeOf("function");
  expect(registerAgent).toBeTypeOf("function");
});
