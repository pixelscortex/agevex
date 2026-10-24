import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const names = ["todo", "goals", "ask-user", "continue-budget"] as const;
const SMOKE_LIMITS = { processMs: 15_000, testMs: 25_000 } as const;
type Item = { files: { content: string; target: string }[] };

async function host() {
  const dir = await mkdtemp(join(tmpdir(), "agevex-tools-"));
  await mkdir(join(dir, "node_modules"));
  for (const name of ["ai", "convex", "zod"])
    await symlink(join(root, "node_modules", name), join(dir, "node_modules", name));
  await symlink(root, join(dir, "node_modules/agevex"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "registry-smoke",
      private: true,
      type: "module",
      packageManager: "bun@1.4.3",
      dependencies: { ai: "^7.0.153", convex: "^1.47.0", zod: "^4.6.7", agevex: `file:${root}` },
    }),
  );
  // Select Bun without running an installer. Every dependency is linked from
  // this checkout; no package downloads are part of the offline smoke test.
  await writeFile(
    join(dir, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 1,
      workspaces: { "": { name: "registry-smoke" } },
      packages: {},
    }),
  );
  // The CLI invokes `bun add` even when dependencies are present. Force that
  // real installer to use only cache, so a missing manifest cannot make the
  // otherwise offline unit suite perform external package-registry requests.
  const bun = (await exec("bun", ["--print", "process.execPath"])).stdout.trim();
  await mkdir(join(dir, "bin"));
  const quotedBun = `'${bun.replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(dir, "bin/bun"),
    `#!/bin/sh
if [ "$1" = "add" ]; then
  shift
  exec ${quotedBun} add --offline "$@"
fi
exec ${quotedBun} "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        paths: { "@/*": ["./*"] },
      },
      include: ["convex/**/*.ts"],
    }),
  );
  await writeFile(join(dir, "style.css"), "@import 'tailwindcss';\n");
  await writeFile(
    join(dir, "components.json"),
    JSON.stringify({
      $schema: "https://ui.shadcn.com/schema.json",
      style: "new-york",
      rsc: false,
      tsx: false,
      tailwind: { config: "", css: "style.css", baseColor: "neutral", cssVariables: true },
      aliases: {
        components: "@/components",
        utils: "@/lib/utils",
        ui: "@/components/ui",
        lib: "@/lib",
        hooks: "@/hooks",
      },
    }),
  );
  return dir;
}

const typecheck = (dir: string) =>
  exec("bunx", ["--no-install", "tsc", "--project", join(dir, "tsconfig.json")], {
    cwd: root,
    timeout: SMOKE_LIMITS.processMs,
  });

for (const name of names)
  it(
    `shadcn installs ${name} into a temporary Convex host and the installed source type-checks offline`,
    async (context) => {
      const dir = await host();
      try {
        const item = join(root, "docs/site/public/r", `${name}.json`);
        // shadcn uses proxy-agent for registry requests. A closed loopback proxy
        // denies external traffic, including its unconditional base-style fetch.
        // --no-install also prevents bunx from downloading the CLI if not cached.
        const proxy = "http://127.0.0.1:9";
        try {
          await exec("bunx", ["--no-install", "shadcn", "add", item, "--yes", "--cwd", dir], {
            cwd: root,
            timeout: SMOKE_LIMITS.processMs,
            env: {
              ...process.env,
              PATH: `${join(dir, "bin")}:${process.env.PATH}`,
              HTTP_PROXY: proxy,
              HTTPS_PROXY: proxy,
              ALL_PROXY: proxy,
              NO_PROXY: "",
              http_proxy: proxy,
              https_proxy: proxy,
              no_proxy: "",
            },
          });
        } catch (error) {
          const detail = error as Error & { stdout?: string; stderr?: string };
          const output = `${detail.message}\n${detail.stdout ?? ""}\n${detail.stderr ?? ""}`;
          const missing = output.match(/--offline: no cached manifest for "([^"]+)"/);
          const network = output.match(
            /ECONNREFUSED|fetch failed|ENOTFOUND|ETIMEDOUT|ENETUNREACH|could not.*fetch/i,
          );
          const uncachedCli = output.match(/bunx:.*(?:not found|not installed)/i);
          if (missing || network || uncachedCli) {
            const cause = missing
              ? `bun add requires uncached manifest ${missing[1]}`
              : (network?.[0] ?? uncachedCli![0]);
            const reason = `Offline shadcn install skipped for ${name}: ${cause}. Network is disabled and dependency installs use --offline; payload type-check runs separately.`;
            console.info(reason);
            context.skip(reason);
            return;
          }
          throw error;
        }
        const payload = JSON.parse(await readFile(item, "utf8")) as Item;
        for (const file of payload.files)
          expect(await readFile(join(dir, file.target.replace(/^~\//, "")), "utf8")).toContain(
            "export",
          );
        await typecheck(dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    SMOKE_LIMITS.testMs,
  );

// Even when upstream shadcn insists on its remote base-style catalogue, every
// committed payload is still type-checked in a fresh host. This supplements
// the explicitly skipped CLI check; it does not pretend an install succeeded.
it(
  "all registry payloads merge into an independent typed host without codegen or schema overwrites",
  async () => {
    const dir = await host();
    try {
      for (const name of names) {
        const payload = JSON.parse(
          await readFile(join(root, "docs/site/public/r", `${name}.json`), "utf8"),
        ) as Item;
        for (const file of payload.files) {
          const path = join(dir, file.target.replace(/^~\//, ""));
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.content);
        }
      }
      await writeFile(
        join(dir, "convex/schema.ts"),
        `
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { todoTables } from "./agevexTools/todoSchema.js";
import { goalTables } from "./agevexTools/goalsSchema.js";
export default defineSchema({ existing: defineTable({ label: v.string() }), ...todoTables, ...goalTables });
`,
      );
      await typecheck(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  SMOKE_LIMITS.testMs,
);
