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
  meter:
    "Invalid configuration/arguments or host policy throws; unknown price is recorded, then denies check.",
  extract: "Host policy or invalid arguments throws; ExtractError carries a closed failure code.",
  sandbox: "Host policy or SANDBOX_* argument/state errors; uncertain effects remain unknown.",
  telemetry: "Invalid configuration/facts throws; export failures are swallowed.",
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
    inline: "Decoder failures become unknown cost when recording.",
    openRouterCost: "Returns undefined for absent or invalid cost evidence.",
    observeProviderOutcome: "Rethrows invoke failure; observation failures are contained.",
    usageHandlerFor: "USAGE_THREAD_REQUIRED; invalid identity or metering errors.",
    polarSink: "SinkDeliveryError for HTTP, timeout or response failures.",
    webhookSink: "SinkDeliveryError for HTTP, timeout or response failures.",
    "meter.threadCost": "Host policy; BreakdownDisabledError for disabled cursor projections.",
    "meter.breakdown":
      "Host policy; BreakdownDisabledError for disabled projections; invalid range.",
    "meter.check": "Host policy; INVALID_BUDGET; unknown costs return allowed: false.",
    "meter.retrySinks": "Host policy; CHARGE_NOT_FOUND.",
    "meter.prune": "Invalid cutoff/limit. Caller must enforce admin authorization.",
    "charge.attach": "REQUEST_ID_CONFLICT, OPERATION_CAPACITY; validation/policy errors.",
    "charge.correct": "OPERATION_CAPACITY; validation/policy errors.",
    "charge.settle": "OPERATION_CAPACITY; validation/policy errors.",
    "charge.get": "Host policy or invalid key.",
    "scoped.estimate": "KEY_CONFLICT; validation/policy errors. Missing pricing records unknown.",
    "scoped.record": "KEY_CONFLICT; validation/policy errors. Invalid evidence records unknown.",
    directText: "BackendResult carries a closed failure; no paid provider call.",
    firecrawlParse: "Invalid options; backend returns a sanitized closed failure.",
    visionOcr: "EXTRACT_MODEL_INSTANCE_REQUIRED; backend returns a closed failure.",
    "extract.get": "Host policy or invalid identity.",
    "extract.readText": "Host policy; EXTRACT_NOT_READY or bounded-payload failure.",
    "extract.readPages": "Host policy; EXTRACT_NOT_READY or bounded-payload failure.",
    "extract.index": "Host policy; EXTRACT_RAG_DISABLED, EXTRACT_INDEX_FENCED, TOO_LARGE.",
    "extract.search": "Host policy; EXTRACT_RAG_DISABLED or invalid arguments.",
    "extract.purge": "Invalid file id. Caller must enforce admin authorization.",
    "trace.flush": "Export errors/timeouts are swallowed; no retries.",
    "trace.integration": "Invalid facts throw; oversized facts export as digests.",
    "telemetry.slot": "Invalid options throw; managed flush fails open.",
    telemetry: "Invalid options throw.",
    langfuse: "Invalid credentials or base URL throw; export fails open.",
    braintrust: "Invalid credentials/project id throw; export fails open.",
    sandboxCompletion: "Callback authorization/failure rolls back settlement.",
    createTodoTools: "Model validation; managed receipt denied/failed/unknown outcomes.",
    createGoalTools: "Model validation; managed receipt denied/failed/unknown outcomes.",
    createAskUserTool: "Model validation; no execute function, so the call is deferred.",
    createContinueBudgetTool: "Model validation; ROOT_ONLY after approval on a child.",
    resumeAfterBudgetStop: "Rejected send code or DUPLICATE_RESUME throws; consent errors deny.",
  };

  return specific[label] ?? fallback;
}
function signatureRow(label: string, type: ts.Type, node: ts.Node, error: string) {
  const sig = type.getCallSignatures()[0];

  if (!sig) return "";

  error = failure(label, error);
  const generics = sig.declaration?.typeParameters?.map((p) => clean(p.getText())).join(", ");
  const display = label + (generics ? `<${generics}>` : "");
  let returns = describe(checker.getReturnTypeOfSignature(sig), node);

  if (label === "defineMeter") returns = "Meter";

  if (label === "defineExtract") returns = "ExtractClient";

  if (label === "defineSandbox") returns = "SandboxClient";

  if (label === "meter.threadCost") returns = "Promise<ThreadCost>";

  if (returns.length > 420)
    returns = label.startsWith("meter.")
      ? `ReturnType<Meter["${label.slice(6)}"]>`
      : label.startsWith("extract.")
        ? `ReturnType<ExtractClient["${label.slice(8)}"]>`
        : label.startsWith("sandbox.")
          ? `ReturnType<SandboxClient["${label.slice(8)}"]>`
          : label === "extractNodeExport"
            ? "Internal execute and read registrations"
            : "AI SDK Tool (typed input/output)";

  return `| \`${display}\` | \`${parameters(sig)}\` | \`${returns}\` | ${error} |`;
}

for (const name of ["meter", "extract", "sandbox", "telemetry", "tools"]) {
  const source = program.getSourceFile(join(repo, `src/modules/${name}/client/index.ts`))!;
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!);
  const rows: string[] = [];
  let instance: ts.Type | undefined;

  for (const entry of exports) {
    const type = checker.getTypeOfSymbolAtLocation(entry, source);

    if (!type.getCallSignatures().length || entry.flags & ts.SymbolFlags.TypeAlias) continue;

    rows.push(signatureRow(entry.name, type, source, errors[name]));

    if (
      entry.name === `define${name[0].toUpperCase() + name.slice(1)}` ||
      entry.name === "telemetry"
    )
      instance = checker.getReturnTypeOfSignature(type.getCallSignatures()[0]);

    if (entry.name === "telemetry") {
      const slot = type.getProperty("slot")!;

      rows.push(
        signatureRow(
          "telemetry.slot",
          checker.getTypeOfSymbolAtLocation(slot, source),
          source,
          "Invalid options throws; managed flush fails open.",
        ),
      );
    }
  }

  if (instance) {
    const prefix = name === "telemetry" ? "trace" : name;

    for (const prop of instance.getProperties()) {
      if (prop.name === "nodeRead") continue; // Internal Node seam documented by extractNodeExport.

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

  if (name === "meter") {
    for (const typeName of ["ScopedMeter", "ChargeHandle"]) {
      const symbol = exports.find((x) => x.name === typeName)!;

      const type = checker.getDeclaredTypeOfSymbol(
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
      );

      for (const prop of type.getProperties())
        rows.push(
          signatureRow(
            (typeName === "ScopedMeter" ? "scoped" : "charge") + "." + prop.name,
            checker.getTypeOfSymbolAtLocation(prop, source),
            source,
            "Validation/policy throws; KEY_CONFLICT, REQUEST_ID_CONFLICT, OPERATION_CAPACITY where applicable.",
          ),
        );
    }
  }

  const intro =
    name === "extract"
      ? "`ExtractClient = ReturnType<typeof defineExtract>`. Request aliases are local documentation types, not package exports: `Scoped = { threadId: string; subject?: string }`; `FileArgs = Scoped & { fileId: string; backend?: string; optionsHash?: string }`; `ArtifactArgs = Scoped & { artifactId: string }`; `Completion` is an internal mutation reference taking `{ artifactId: string }` and returning null or void. `AttachmentRuntime` is the runtime returned by `registerAgent` restricted to `fileAttached`. `ActionCtx` is `GenericActionCtx<GenericDataModel>` from `convex/server`. "
      : name === "sandbox"
        ? "`SandboxClient = ReturnType<typeof defineSandbox>`. `SandboxCall` accepts a full core `ToolContext`. For `daytona`, `ComponentApi` is the Daytona component type from `@daytona/convex`; its local `DaytonaSandboxOptions` extends the dependency type `DaytonaOptions` with optional `snapshot`, `target`, `autoStopInterval` and `autoArchiveInterval`."
        : name === "meter"
          ? "`Meter`, context, provider and charge types are exported from `agevex/meter`. Budget and usage slot types are exported from `agevex`; `UsageHandler` comes from `@convex-dev/agent`."
          : name === "tools"
            ? "AI SDK tool types come from `ai`. Local `Result` is `{ todos: { id: string; text: string; done: boolean }[] }`; `Context` is the AI SDK context type."
            : "Telemetry contracts are exported from `agevex/telemetry`. `Telemetry` is the AI SDK integration type from `ai`.";

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
