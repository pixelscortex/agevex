/** Run the documented hook example: rendering must not issue mutations. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vite-plus/test";

it("the documented conversation hook sends and renames only from event handlers", async () => {
  const doc = readFileSync(
    new URL("../../docs/site/content/docs/concepts/react-hooks.mdx", import.meta.url),
    "utf8",
  );

  const example = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .find((code) => code.includes("createAgevexHooks"))!;

  // Supply stub hooks for the example's imports/factory, then run its real body.
  const source = ts.createSourceFile("example.ts", example, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter();

  const body = source.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .filter(
      (statement) =>
        !(
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (decl) => decl.name.getText(source) === "agents",
          )
        ),
    )
    .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, source))
    .join("\n");

  const compiled = ts.transpileModule(body, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;

  const send = vi.fn(async () => ({ status: "accepted" }));
  const rename = vi.fn(async () => ({ version: 2 }));

  const agents = {
    useThread: () => ({ send }),
    useRunTree: () => ({ status: "ready" }),
    useTitle: () => ({ rename }),
  };

  const actions = await runInNewContext(
    `(async () => { const exports = {}; ${compiled}\nreturn exports.useConversation?.(threadId, rootRunId); })();`,
    { agents, threadId: "thread", rootRunId: "run" },
  );

  expect(send).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
  await actions.handleSend();
  await actions.handleRename();
  expect(send).toHaveBeenCalledExactlyOnceWith("Review the next card");
  expect(rename).toHaveBeenCalledExactlyOnceWith("Card review");
});
