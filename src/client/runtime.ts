// `registerAgent`: the host's single entry point to the managed runtime.
//
// It resolves one registration into a `RuntimeContext` (`registration/`) and
// returns what the host exports: the public endpoints (`endpoints/`), the two
// internal functions the component dispatches to (`runTurn` from `turn/` and the
// collaboration coordinator from `coordinate/`), and trusted server-side helpers
// (`host/`, `tasks.ts`). Nothing here reads or writes tables directly; every
// builder receives the resolved context explicitly. `client/README.md` maps the
// rest of the client.

import type { ComponentApi } from "../component/_generated/component.js";
import { buildCoordinate } from "./coordinate/coordinator.js";
import { authorizedEndpoints } from "./endpoints/index.js";
import {
  fileAttached,
  registerFile,
  type FileAttachedArgs,
  type RegisterFileArgs,
} from "./host/files.js";
import { note, sandboxComplete, type NoteArgs, type SandboxCompletion } from "./host/notes.js";
import {
  createRuntimeContext,
  type CoordinatorCtx,
  type RunnerCtx,
} from "./registration/context.js";
import { runTask, type Task, type TaskOptions } from "./tasks.js";
import { buildRunTurn } from "./turn/run-turn.js";
import type { Registration } from "./types.js";

export { ASK_PARENT_TOOL_NAME, DELEGATE_TOOL_NAME, MESSAGE_CHILD_TOOL_NAME } from "./tool-names.js";
export type { SandboxCompletion };

/**
 * Register one managed, bounded agent graph with the Agevex Convex runtime.
 *
 * The agent instances define native behavior; registration connects their graph
 * to the component, dispatch references, and host authorization policy. Direct
 * native methods remain unmanaged.
 *
 * Throws a typed registration error (see `registration/context.ts`) for any
 * graph, slot or model configuration the runtime cannot execute safely.
 */
export function registerAgent(component: ComponentApi, config: Registration) {
  const rt = createRuntimeContext(component, config);
  return {
    /** Run a structured task outside a turn, metered by the registration's usage slot. */
    runTask: <Input, Output>(
      ctx: RunnerCtx,
      task: Task<Input, Output>,
      input: Input,
      options: TaskOptions = {},
    ) => runTask(ctx, task, input, { ...options, component, usage: config.usage ?? options.usage }),
    /** Trusted upload-path helper: bind a stored native file to an authorized subject. */
    registerFile: (ctx: CoordinatorCtx, args: RegisterFileArgs) => registerFile(rt, ctx, args),
    /** Exact attachment policy for an extract adapter's authorize callback. */
    fileAttached: (ctx: Pick<RunnerCtx, "runQuery">, args: FileAttachedArgs) =>
      fileAttached(rt, ctx, args),
    sandboxComplete: (ctx: CoordinatorCtx, event: SandboxCompletion) =>
      sandboxComplete(rt, ctx, event),
    note: (ctx: CoordinatorCtx, args: NoteArgs): Promise<boolean> => note(rt, ctx, args),
    /** The subject-authorized public queries and mutations the host exports. */
    authorizedEndpoints: () => authorizedEndpoints(component, config),
    /** The internal functions the host exports as `refs.runTurn` and `refs.coordinate`. */
    internalFunctions: () => {
      const coordinate = buildCoordinate(rt);
      const runTurn = buildRunTurn(rt);
      return { runTurn, coordinate };
    },
  };
}
