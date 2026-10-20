import { Agent as NativeAgent, type AgentComponent, type Config } from "@convex-dev/agent";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Instructions, LanguageModel, StopCondition, ToolSet } from "ai";
import type { ManagedAgent } from "./types.js";

type AgentOptions<Tools extends ToolSet> = Config & {
  name: string;
  languageModel: Extract<LanguageModel, string | LanguageModelV4>;
  instructions?: Instructions;
  tools?: Tools;
  stopWhen?: StopCondition<NoInfer<Tools>> | StopCondition<NoInfer<Tools>>[];
  /**
   * Agents this one may delegate to through the managed `agevex_delegate` tool.
   * Must be real `Agent` objects, not names: `registerAgevex` resolves the
   * executable child through this list. Managed depth is 1, so a child declares
   * `subagents: []`.
   */
  subagents: readonly ManagedAgent[];
};

// Equivalent supported constructor inputs, without the upstream intersection of
// two enormous gateway-model unions (TS2590 on TypeScript 5.9). Only the
// constructor signature is normalized; the instance type is entirely native.
const NativeBase = NativeAgent as unknown as {
  new <CustomCtx extends object, Tools extends ToolSet>(
    component: AgentComponent,
    options: AgentOptions<Tools>,
  ): NativeAgent<CustomCtx, Tools>;
};

/** Shared empty tool bag, so a tool-less agent costs no per-instance allocation. */
const EMPTY_TOOLS: ToolSet = {};

/** Native Agent plus metadata; generation, tools, threads and streams stay native. */
export class Agent<
  CustomCtx extends object = object,
  // Match the upstream generic default exactly, including no-tools return types.
  AgentTools extends ToolSet = any,
> extends NativeBase<CustomCtx, AgentTools> {
  /** Type-only marker: managed registration cannot supply required custom context. */
  declare readonly _agevexContext: (ctx: CustomCtx) => void;
  readonly name: string;
  readonly subagents: readonly ManagedAgent[];
  /**
   * Native tools declared on this agent, kept so the managed runtime can merge
   * its reserved delegation tool with them. Inherited native behavior is
   * unchanged: a managed turn passes the merged set per call, exactly as the
   * native `streamText` `tools` override already allows.
   */
  readonly declaredTools: ToolSet;

  constructor(component: AgentComponent, options: AgentOptions<AgentTools>) {
    super(component, options);
    this.name = options.name;
    this.subagents = options.subagents;
    this.declaredTools = options.tools ?? EMPTY_TOOLS;
  }
}
