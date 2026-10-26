/** The optional browser subpath also loads during server-side rendering. */
import { expect, it } from "vite-plus/test";

it("the React subpath loads without a DOM", async () => {
  expect(typeof document).toBe("undefined");
  const { createAgevexHooks } = await import("../../src/react/index.js");

  expect(createAgevexHooks({})).toHaveProperty("useThread");
});
