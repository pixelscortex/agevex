/**
 * SDK tools and the agevex sandbox slot.
 * Effects use the core once-tool ledger; reads return bounded data without receipts.
 * The slot binds delegated calls to the root conversation while retaining the subject.
 */
import { tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import { defineOnceTool, type ToolContext } from "../../../client/once.js";
import { type SandboxSlot } from "../../../client/slots.js";
import { LIMITS, bounded } from "../shared/limits.js";
import { facts, type RuntimeContext } from "./runtime-context.js";
import { readFile, writeFile, list } from "./files.js";
import { exec, background } from "./execution.js";

/**
 * Plain SDK tools. Effects are bound by core's defineOnceTool ledger. Pure
 * reads accept trusted AI SDK `context` (or an explicit host ToolContext),
 * avoiding storing up to 640 KiB of file text in a 64 KiB receipt.
 *
 * `bind` chooses which trusted facts key the sandbox. It runs on every
 * ToolContext the tools see (once-tool body, key function and read
 * context), so no code path can reach a sandbox through unbound facts.
 */
export function buildTools(
  runtime: RuntimeContext,
  context: ToolContext | undefined,
  bind: (tc: ToolContext) => ToolContext,
) {
  const { limits } = runtime;

  const key = (_input: unknown, tc: ToolContext) => {
    // Validate attribution before core constructs a receipt scope, rather
    // than waiting until the effect body after admission has already written.
    facts(bind(tc));

    return bounded(tc.toolCallId, LIMITS.identityChars, "TOOL_CALL_ID");
  };

  const path = z
    .string()
    .min(1)
    .max(LIMITS.pathChars)
    .refine((value) => !value.includes("\0"));

  const command = z
    .string()
    .min(1)
    .max(LIMITS.commandChars)
    .refine((value) => !value.includes("\0"));

  const readContext = (opts: ToolExecutionOptions<unknown>) => {
    const tc = context ?? (opts.context as ToolContext | undefined);

    if (!tc?.ctx || !tc.signal) throw new Error("MANAGED_TOOL_CONTEXT_REQUIRED");

    return bind({ ...tc, toolCallId: opts.toolCallId });
  };

  return {
    sandbox_exec: defineOnceTool({
      name: "sandbox_exec",
      description: `Run one shell command in your sandbox; returns the exit code and the last ${limits.outputChars} characters of output (timeout ${limits.commandTimeoutS}s).`,
      key,
      input: z.object({ command }),
      run: (input, tc) => exec(runtime, bind(tc), input),
    }),
    sandbox_read_file: tool({
      description: `Read a text file from your sandbox; only the last ${limits.fileReadChars} characters are returned.`,
      inputSchema: z.object({ path }),
      execute: (input, opts) => readFile(runtime, readContext(opts), input),
    }),
    sandbox_write_file: defineOnceTool({
      name: "sandbox_write_file",
      description: `Write a text file in your sandbox, replacing it if it exists (at most ${limits.writeChars} characters).`,
      key,
      input: z.object({ path, content: z.string().max(limits.writeChars) }),
      run: (input, tc) => writeFile(runtime, bind(tc), input),
    }),
    sandbox_list: tool({
      description: `List a directory in your sandbox (name, isDir, size); at most ${limits.listEntries} entries.`,
      inputSchema: z.object({ path }),
      execute: (input, opts) => list(runtime, readContext(opts), input),
    }),
    sandbox_run_background: defineOnceTool({
      name: "sandbox_run_background",
      description:
        "Start a long-running shell command in your sandbox and return a job id at once; you are notified when it finishes, with its exit code and the end of its log.",
      key,
      input: z.object({ command }),
      run: (input, tc) => background(runtime, bind(tc), input),
    }),
  };
}

/** Standalone tools: the sandbox is keyed by the facts exactly as supplied. */
export function tools(runtime: RuntimeContext, context?: ToolContext) {
  return buildTools(runtime, context, (tc) => tc);
}

/**
 * The agevex sandbox slot (`registerAgent({ sandbox: sandbox.slot() })`).
 *
 * Core calls `tools(context)` once per turn slice with that turn's trusted
 * ToolContext; managed once-tools are then bound by core to the same facts.
 * The sandbox is keyed by `rootThreadId` instead of the acting `threadId`:
 * a delegated child runs on its own thread, but it works in its parent
 * conversation's sandbox, and a background-job completion must name a thread
 * that core's `sandboxComplete` can post a note to (the root conversation the
 * user and the root agent are in). `subject` stays in every scope key, so one
 * subject can never address another's sandbox, whatever the model sends.
 */
export function slot(runtime: RuntimeContext): SandboxSlot {
  return {
    tools: (context) =>
      buildTools(runtime, context, (tc) => ({ ...tc, threadId: tc.rootThreadId })),
  };
}
