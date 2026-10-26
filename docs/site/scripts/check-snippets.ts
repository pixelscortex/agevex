// Compile every docs TypeScript block in temporary host apps against built exports.
// Typed API references catch stale arguments without deploying or calling providers.
import { join, dirname } from "node:path";
import { mkdir, symlink, readdir, copyFile, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const fixture = await mkdtemp(join("/tmp", "agevex-doc-snippets-"));

await mkdir(fixture, { recursive: true });
await mkdir(join(fixture, "node_modules"), { recursive: true });

for (const dep of await readdir(join(repo, "node_modules"))) {
  if (dep === "agevex" || dep === ".bin") continue;

  try {
    await symlink(join(repo, "node_modules", dep), join(fixture, "node_modules", dep));
  } catch {}
}

try {
  await symlink(repo, join(fixture, "node_modules/agevex"));
} catch {}

await Bun.write(join(fixture, "package.json"), JSON.stringify({ type: "module", private: true }));
const blocks: { page: string; title: string; code: string; lang: string }[] = [];
const glob = new Bun.Glob("**/*.mdx");

for await (const path of glob.scan(join(repo, "docs/site/content/docs"))) {
  const content = await Bun.file(join(repo, "docs/site/content/docs", path)).text();

  for (const match of content.matchAll(/```(\w+)([^\n]*)\n([\s\S]*?)```/g)) {
    if (!["ts", "tsx", "json"].includes(match[1])) continue;

    const title = /title="([^"]+)"/.exec(match[2])?.[1] ?? "snippet";

    blocks.push({ page: path, title, code: match[3], lang: match[1] });
  }
}

const base = blocks.filter((b) => b.page === "getting-started.mdx");
const pageNames = [...new Set(blocks.map((b) => b.page))];

const typeImports = `import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type { ComponentApi as Core } from "agevex/_generated/component.js";
import type { AgentComponent } from "@convex-dev/agent";
import type { ComponentApi as Meter } from "agevex/meter/_generated/component.js";
import type { ComponentApi as Extract } from "agevex/extract/_generated/component.js";
import type { ComponentApi as Sandbox } from "agevex/sandbox/_generated/component.js";
import type { ComponentApi as Daytona } from "@daytona/convex";
`;

const all: string[] = [];

for (const page of pageNames) {
  const group = join(fixture, page.replace(/\.mdx$/, "").replaceAll("/", "-"));

  await mkdir(join(group, "convex/_generated"), { recursive: true });
  const modules: Record<string, string> = { agents: "../agents.js" };

  for (const b of base) {
    if (b.lang === "ts" && b.title.startsWith("convex/"))
      await Bun.write(join(group, b.title), b.code);
  }

  for (const item of ["todo", "goals", "ask-user", "continue-budget"]) {
    const source = join(repo, "src/modules/tools/registry", item);

    for (const file of await readdir(source)) {
      if (!file.endsWith(".ts")) continue;

      await mkdir(join(group, "convex/agevexTools"), { recursive: true });
      await copyFile(join(source, file), join(group, "convex/agevexTools", file));

      if (file.endsWith("State.ts"))
        modules["agevexTools/" + file.slice(0, -3)] =
          "../agevexTools/" + file.replace(/\.ts$/, ".js");
    }
  }

  let index = 0;

  for (const b of blocks.filter((b) => b.page === page)) {
    index++;

    if (b.lang === "json") {
      JSON.parse(b.code);
      continue;
    }

    const target = /^(convex|client)\/.*\.tsx?$/.test(b.title)
      ? b.title
      : `convex/snippet${index}.ts`;

    await mkdir(dirname(join(group, target)), { recursive: true });
    await Bun.write(join(group, target), b.code);
    all.push(`${page} #${index}: ${b.title}`);

    if (
      target.startsWith("convex/") &&
      !target.endsWith("convex.config.ts") &&
      !target.endsWith("agentConfig.ts")
    ) {
      const mod = target.slice("convex/".length, -3);

      modules[mod] = "../" + mod + ".js";
    }
  }

  const typedModules = Object.entries(modules)
    .map(([name, path]) => `  "${name}": typeof import("${path}");`)
    .join("\n");

  await Bun.write(
    join(group, "convex/_generated/api.ts"),
    `${typeImports}
type FullApi = ApiFromModules<{\n${typedModules}\n}>;
export declare const api: FilterApi<FullApi, FunctionReference<any,"public">>;
export declare const internal: FilterApi<FullApi, FunctionReference<any,"internal">>;
export declare const components: {agevex:Core;agent:AgentComponent;meter:Meter;agevexExtract:Extract;sandbox:Sandbox;daytona:Daytona};
`,
  );
}

await Bun.write(
  join(fixture, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ESNext",
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ["node"],
        verbatimModuleSyntax: true,
        isolatedModules: true,
      },
      include: ["**/*.ts"],
    },
    null,
    2,
  ),
);

await Bun.write(join(fixture, "manifest.json"), JSON.stringify(all, null, 2));

console.log(
  `Extracted ${all.length} TypeScript blocks across ${pageNames.length} pages; JSON blocks parsed.`,
);

const result = Bun.spawn(
  ["bunx", "--no-install", "tsc", "--noEmit", "--project", join(fixture, "tsconfig.json")],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);

const exitCode = await result.exited;

console.log(`Snippet fixture and manifest: ${fixture}`);
process.exitCode = exitCode;
