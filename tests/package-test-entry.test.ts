/**
 * The published test entry points expose what the README promises: the core
 * `register` helper and the offline sandbox fake from `agevex/test`, and the
 * fake from `agevex/sandbox/test`. Resolves the paths through package.json
 * `exports`, so a mis-mapped subpath fails here instead of in a host.
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const exportsMap = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  .exports as Record<string, string>;

it("agevex/test exports register and fakeSandboxProvider", async () => {
  const entry = await import(new URL(`../${exportsMap["./test"]}`, import.meta.url).href);

  expect(typeof entry.register).toBe("function");
  expect(typeof entry.fakeSandboxProvider).toBe("function");
});

it("agevex/sandbox/test exports register and fakeSandboxProvider", async () => {
  const entry = await import(new URL(`../${exportsMap["./sandbox/test"]}`, import.meta.url).href);

  expect(typeof entry.register).toBe("function");
  expect(typeof entry.fakeSandboxProvider).toBe("function");
});
