import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const names = ["todo", "goals", "ask-user", "continue-budget"] as const;
// Network is opt-in so the ordinary fake-backend suite remains offline. The
// same installation assertions must run when the upstream catalogue is reachable.
const network = process.env.AGEVEX_TOOLS_INSTALL_NETWORK === "1";

const SMOKE_LIMITS = {
  processMs: network ? 60_000 : 15_000,
  testMs: network ? 90_000 : 25_000,
} as const;

type Item = { files: { content: string; target: string }[] };

async function mergeSchema(dir: string, installed: readonly (typeof names)[number][]) {
  const snippets = [
    { name: "todo", table: "todoTables", file: "todoSchema" },
    { name: "goals", table: "goalTables", file: "goalsSchema" },
    { name: "continue-budget", table: "consentTables", file: "continueBudgetSchema" },
  ] as const;

  const tables = snippets.filter((snippet) => installed.includes(snippet.name));

  await mkdir(join(dir, "convex"), { recursive: true });

  await writeFile(
    join(dir, "convex/schema.ts"),
    `
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
${tables.map(({ table, file }) => `import { ${table} } from "./agevexTools/${file}.js";`).join("\n")}
export default defineSchema({ existing: defineTable({ label: v.string() }), ${tables.map(({ table }) => `...${table}`).join(", ")} });
`,
  );
}

// Registers the installed tools on a real agevex Agent in the fresh host. The
// host links the same `ai` as agevex (as a real install would), so no `paths`
// override is involved: a tool typed against a different `ai` copy fails here.
async function writeWiring(dir: string, installed: readonly (typeof names)[number][]) {
  const state = installed
    .filter((name) => name === "todo" || name === "goals" || name === "continue-budget")
    .map((name) => (name === "continue-budget" ? "continueBudget" : name));

  const modules = state.map((name) => `"agevexTools/${name}State": typeof ${name}State;`);

  await mkdir(join(dir, "convex/_generated"), { recursive: true });

  await writeFile(
    join(dir, "convex/_generated/api.ts"),
    `// Stand-in for \`convex codegen\`, which needs a deployment.
import { anyApi, type ApiFromModules, type FilterApi, type FunctionReference } from "convex/server";
${state.map((name) => `import type * as ${name}State from "../agevexTools/${name}State.js";`).join("\n")}
type Full = ApiFromModules<{ ${modules.join(" ")} }>;
export const internal = anyApi as unknown as FilterApi<Full, FunctionReference<any, "internal">>;
`,
  );

  const imports = [
    installed.includes("todo") && `import { createTodoTools } from "./agevexTools/todo.js";`,
    installed.includes("goals") && `import { createGoalTools } from "./agevexTools/goals.js";`,
    installed.includes("ask-user") &&
      `import { createAskUserTool } from "./agevexTools/askUser.js";`,
    installed.includes("continue-budget") &&
      `import { createContinueBudgetTool } from "./agevexTools/continueBudget.js";`,
  ].filter(Boolean);

  const tools = [
    installed.includes("todo") && "...createTodoTools(internal.agevexTools.todoState),",
    installed.includes("goals") && "...createGoalTools(internal.agevexTools.goalsState),",
    installed.includes("ask-user") && "ask_user: createAskUserTool(),",
    installed.includes("continue-budget") && "continue_budget: createContinueBudgetTool(),",
  ].filter(Boolean);

  await writeFile(
    join(dir, "convex/agent.ts"),
    `import { Agent } from "agevex";
import type { AgentComponent } from "@convex-dev/agent";
import { internal } from "./_generated/api.js";
${imports.join("\n")}

declare const agentComponent: AgentComponent;
declare const languageModel: ConstructorParameters<typeof Agent>[1]["languageModel"];
export const main = new Agent(agentComponent, {
  name: "Main",
  subagents: [],
  languageModel,
  tools: { ${tools.join(" ")} },
});
`,
  );
}

async function host() {
  const dir = await mkdtemp(join(tmpdir(), "agevex-tools-"));

  await mkdir(join(dir, "node_modules"));

  for (const name of ["ai", "convex", "zod"])
    await symlink(join(root, "node_modules", name), join(dir, "node_modules", name));

  await mkdir(join(dir, "node_modules/@convex-dev"));

  await symlink(
    join(root, "node_modules/@convex-dev/agent"),
    join(dir, "node_modules/@convex-dev/agent"),
  );

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

  // The CLI invokes `bun add` even when dependencies are present. Unless this
  // run explicitly permits network, force the real installer to use only cache
  // so missing manifests cannot trigger external package-registry requests.
  const bun = (await exec("bun", ["--print", "process.execPath"])).stdout.trim();

  await mkdir(join(dir, "bin"));
  const quotedBun = `'${bun.replaceAll("'", "'\\''")}'`;

  await writeFile(
    join(dir, "bin/bun"),
    `#!/bin/sh
if [ "$1" = "add" ]; then
  shift
  exec ${quotedBun} add ${network ? "" : "--offline "}"$@"
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
      tsx: true,
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

  await mergeSchema(dir, []);

  return dir;
}

// tsc reports diagnostics on stdout; surface them so a failure names its cause.
const typecheck = async (dir: string) => {
  try {
    await exec("bunx", ["--no-install", "tsc", "--project", join(dir, "tsconfig.json")], {
      cwd: root,
      timeout: SMOKE_LIMITS.processMs,
    });
  } catch (error) {
    throw new Error(`${(error as { stdout?: string }).stdout ?? error}`);
  }
};

for (const name of names)
  it(
    `shadcn installs ${name} into a temporary Convex host and the installed source and merged schema type-check`,
    async (context) => {
      const dir = await host();

      try {
        const item = join(root, "docs/site/public/r", `${name}.json`);
        // In the default offline mode, a closed loopback proxy denies shadcn's
        // unconditional base-style fetch; --no-install also prevents CLI downloads.
        const proxy = "http://127.0.0.1:9";

        try {
          await exec(
            "bunx",
            [...(network ? [] : ["--no-install"]), "shadcn", "add", item, "--yes", "--cwd", dir],
            {
              cwd: root,
              timeout: SMOKE_LIMITS.processMs,
              env: {
                ...process.env,
                PATH: `${join(dir, "bin")}:${process.env.PATH}`,
                ...(network
                  ? {}
                  : {
                      HTTP_PROXY: proxy,
                      HTTPS_PROXY: proxy,
                      ALL_PROXY: proxy,
                      NO_PROXY: "",
                      http_proxy: proxy,
                      https_proxy: proxy,
                      no_proxy: "",
                    }),
              },
            },
          );
        } catch (error) {
          const detail = error as Error & { stdout?: string; stderr?: string };
          const output = `${detail.message}\n${detail.stdout ?? ""}\n${detail.stderr ?? ""}`;
          const missing = output.match(/--offline: no cached manifest for "([^"]+)"/);

          const unavailableNetwork = output.match(
            /ECONNREFUSED|fetch failed|ENOTFOUND|ETIMEDOUT|ENETUNREACH|could not.*fetch/i,
          );

          const uncachedCli = output.match(/bunx:.*(?:not found|not installed)/i);

          if (missing || unavailableNetwork || uncachedCli) {
            const cause = missing
              ? `bun add requires uncached manifest ${missing[1]}`
              : (unavailableNetwork?.[0] ?? uncachedCli![0]);

            const reason = `Shadcn install skipped for ${name}: ${cause}. ${network ? "Network is unavailable." : "Network is disabled and dependency installs use --offline."} Payload type-check runs separately.`;

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

        // Follow the documented host setup against CLI-installed TypeScript.
        // A JS-mode install makes these .js imports untyped (TS7016), while a
        // missing table snippet or schema overwrite must also fail this path.
        expect(await readFile(join(dir, "convex/schema.ts"), "utf8")).toContain("existing:");
        await mergeSchema(dir, [name]);
        await writeWiring(dir, [name]);
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

      await mergeSchema(dir, names);
      await writeWiring(dir, names);
      await typecheck(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  SMOKE_LIMITS.testMs,
);
