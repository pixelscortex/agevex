// Generate module reference tables from the root package TypeScript program.
// Use the root compiler: the independent docs app uses the native TS 7 CLI.
import ts from "../../../node_modules/typescript/lib/typescript.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const config = ts.readConfigFile(join(repo, "tsconfig.json"), (path) => ts.sys.readFile(path));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repo);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

const flags =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

const errors: Record<string, string> = {
  sandbox: "Host policy or SANDBOX_* argument/state errors; uncertain effects remain unknown.",
  telemetry: "Factory, callback and flush failures are swallowed; execution failures propagate.",
  tools:
    "Invalid model input fails validation; fenced effects return denied/failed/unknown outcomes.",
};

function clean(s: string) {
  return s
    .replace(/import\("[^"\n]+"\)\./g, "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|");
}
function describe(type: ts.Type, node: ts.Node) {
  return clean(checker.typeToString(type, node, flags));
}
function parameters(sig: ts.Signature) {
  return (
    sig.parameters
      .map((p) => {
        const decl = p.valueDeclaration!;
        const typ = checker.getTypeOfSymbolAtLocation(p, decl);

        if ((decl as ts.ParameterDeclaration).dotDotDotToken && checker.isTupleType(typ))
          return describe(typ, decl).slice(1, -1);

        const annotation = (decl as ts.ParameterDeclaration).type;

        const printed =
          annotation && !annotation.getText().includes("typeof")
            ? clean(annotation.getText())
            : describe(typ, decl);

        return (
          (p.name === "__0" ? "options" : p.name) +
          (p.flags & ts.SymbolFlags.Optional ||
          (decl as ts.ParameterDeclaration).questionToken ||
          (decl as ts.ParameterDeclaration).initializer
            ? "?"
            : "") +
          ": " +
          printed
        );
      })
      .join(", ") || "—"
  );
}
function failure(label: string, fallback: string) {
  const specific: Record<string, string> = {
    telemetry: "Factory, callback and flush failures are swallowed; execution failures propagate.",
    sandboxCompletion: "Callback authorization/failure rolls back settlement.",
    createAskUserTool: "Model validation; no execute function, so the call is deferred.",
  };

  return specific[label] ?? fallback;
}
// One row per call signature, so every overload is documented.
function signatureRow(label: string, type: ts.Type, node: ts.Node, error: string) {
  return type
    .getCallSignatures()
    .map((sig) => signatureRowFor(label, sig, node, error))
    .join("\n");
}
function signatureRowFor(label: string, sig: ts.Signature, node: ts.Node, error: string) {
  error = failure(label, error);
  const generics = sig.declaration?.typeParameters?.map((p) => clean(p.getText())).join(", ");
  const display = label + (generics ? `<${generics}>` : "");
  let returns = describe(checker.getReturnTypeOfSignature(sig), node);

  if (label === "defineSandbox") returns = "SandboxClient";

  if (returns.length > 420)
    returns = label.startsWith("sandbox.")
      ? `ReturnType<SandboxClient["${label.slice(8)}"]>`
      : "AI SDK Tool (typed input/output)";

  return `| \`${display}\` | \`${parameters(sig)}\` | \`${returns}\` | ${error} |`;
}

for (const name of ["sandbox", "telemetry", "tools"]) {
  const source = program.getSourceFile(join(repo, `src/modules/${name}/client/index.ts`))!;
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!);
  const rows: string[] = [];
  let instance: ts.Type | undefined;

  for (const entry of exports) {
    const type = checker.getTypeOfSymbolAtLocation(entry, source);

    if (!type.getCallSignatures().length || entry.flags & ts.SymbolFlags.TypeAlias) continue;

    rows.push(signatureRow(entry.name, type, source, errors[name]));

    if (entry.name === `define${name[0].toUpperCase() + name.slice(1)}`)
      instance = checker.getReturnTypeOfSignature(type.getCallSignatures()[0]);
  }

  if (instance) {
    const prefix = name;

    for (const prop of instance.getProperties()) {
      rows.push(
        signatureRow(
          prefix + "." + prop.name,
          checker.getTypeOfSymbolAtLocation(prop, source),
          source,
          errors[name],
        ),
      );
    }
  }

  const intro =
    name === "sandbox"
      ? "`SandboxClient = ReturnType<typeof defineSandbox>`. `SandboxCall` accepts a full core `ToolContext`. For `daytona`, `ComponentApi` is the Daytona component type from `@daytona/convex`; its local `DaytonaSandboxOptions` extends the dependency type `DaytonaOptions` with optional `snapshot`, `target`, `autoStopInterval` and `autoArchiveInterval`."
      : name === "tools"
        ? "`createAskUserTool` comes from `agevex/tools`; no host tables or installation step."
        : "`telemetry({ integration, flush? })` accepts AI SDK 7 `Telemetry` or a synchronous facts factory. `TelemetryFacts` is readonly core attribution plus `turnKey`.";

  const table = `{/* GENERATED_API_START */}\n\nGenerated from the current exported TypeScript signatures in [the module entry](https://github.com/pixelscortex/agevex/blob/HEAD/src/modules/${name}/client/index.ts). TypeScript does not encode thrown errors; the error column describes implementation behavior.\n\n${intro}\n\n| Name | Arguments | Returns | Errors / failure behavior |\n| --- | --- | --- | --- |\n${rows.filter(Boolean).join("\n")}\n\n{/* GENERATED_API_END */}`;
  const path = join(repo, `docs/site/content/docs/modules/${name}.mdx`);
  const original = await Bun.file(path).text();

  await Bun.write(
    path,
    original.replace(
      /\{\/\* GENERATED_API_START \*\/\}[\s\S]*?\{\/\* GENERATED_API_END \*\/\}/,
      table,
    ),
  );

  console.log(name, rows.filter(Boolean).length, "rows", table.length, "bytes");
}

// Keep regeneration byte-stable with the formatter used by root checks.
const formatting = Bun.spawn(
  ["bunx", "--no-install", "oxfmt", "-c", "oxfmt.config.ts", "docs/site/content/docs/modules"],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);

if ((await formatting.exited) !== 0) throw new Error("API reference formatting failed");
