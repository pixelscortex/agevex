// Proves the @convex-dev rules really run through Vite+/Oxlint for component
// sources: the invalid probe must fail with a @convex-dev rule id, and the
// corrected probe must pass. Both probes live under src/component/ so they use
// exactly the same effective config as the component sources, and each probe
// is removed before the next one runs.
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const probePath = join(repoRoot, "src", "component", "convex-lint-probe.ts");
const fixtureDir = join(repoRoot, "scripts", "fixtures");
const expectedRule = "@convex-dev/require-args-validator";
// Oxlint reports plugin rules as "@convex-dev(rule-name)"; match either spelling.
const expectedRulePattern = /@convex-dev(?:\/|\()require-args-validator/;

async function lintProbe(): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(["bun", "run", "vp", "lint", "src/component/convex-lint-probe.ts"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;

  return { code: proc.exitCode, output: `${stdout}${stderr}` };
}

async function lintFixture(fixture: string): Promise<{ code: number; output: string }> {
  // Create the probe exclusively so concurrent gates cannot clobber each other's
  // probe; `wx` fails instead of overwriting when the file already exists.
  try {
    await writeFile(probePath, await readFile(join(fixtureDir, fixture), "utf8"), {
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      console.error(`refusing to overwrite existing probe: ${probePath}`);
      process.exit(1);
    }

    throw error;
  }

  try {
    return await lintProbe();
  } finally {
    // Only reached after this run created the probe, so the removal can never
    // delete a file owned by a competing invocation.
    await rm(probePath, { force: true });
  }
}

const invalid = await lintFixture("convex-invalid-query.ts.txt");

if (invalid.code === 0) {
  console.error("convex lint gate: invalid fixture passed, Convex rules are not wired");
  console.error(invalid.output);
  process.exit(1);
}

if (!expectedRulePattern.test(invalid.output)) {
  console.error(`convex lint gate: expected a ${expectedRule} failure, got:`);
  console.error(invalid.output);
  process.exit(1);
}

console.log(
  `convex lint gate: invalid fixture rejected with ${expectedRule} (exit ${invalid.code})`,
);

const valid = await lintFixture("convex-valid-query.ts.txt");

if (valid.code !== 0) {
  console.error("convex lint gate: valid fixture failed:");
  console.error(valid.output);
  process.exit(1);
}

console.log("convex lint gate: valid fixture accepted (exit 0)");
