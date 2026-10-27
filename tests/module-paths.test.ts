/**
 * Convex module paths must be deployable.
 *
 * Convex rejects a push when any function module path segment contains a
 * character other than letters, digits, `_` or `.` ("InvalidConfig: Invalid
 * module path 'turns/decision-proposals.js'"). convex-test does not check
 * paths, so a hyphenated file inside a component directory passes every
 * offline suite and only fails when a host runs `convex dev` or deploys.
 * This test walks every component directory (each folder that holds a
 * `convex.config.ts`) and fails on the first undeployable path. The real
 * push check is `bun run check:deploy` (scripts/check-deploy.sh).
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

const SEGMENT = /^[A-Za-z0-9_.]+$/;

/** Every folder under src that defines a Convex component. */
function componentDirs(dir: string): string[] {
  const found: string[] = [];

  for (const name of readdirSync(dir)) {
    const path = join(dir, name);

    if (!statSync(path).isDirectory() || name === "node_modules") continue;

    if (readdirSync(path).includes("convex.config.ts")) found.push(path);

    found.push(...componentDirs(path));
  }

  return found;
}

/** Every file path below a component folder, relative to it. */
function modulePaths(root: string, dir = root): string[] {
  const paths: string[] = [];

  for (const name of readdirSync(dir)) {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) paths.push(...modulePaths(root, path));
    else paths.push(relative(root, path));
  }

  return paths;
}

describe("component module paths", () => {
  const dirs = componentDirs(SRC);

  it("finds the core and module components", () => {
    expect(dirs.map((dir) => relative(SRC, dir)).sort()).toEqual(
      expect.arrayContaining(["component", "modules/sandbox/component"]),
    );
  });

  it.each(dirs.map((dir) => [relative(SRC, dir), dir]))(
    "every path segment in %s is deployable by Convex",
    (_name, dir) => {
      const invalid = modulePaths(dir).filter((path) =>
        path.split("/").some((segment) => !SEGMENT.test(segment)),
      );

      expect(invalid).toEqual([]);
    },
  );
});
