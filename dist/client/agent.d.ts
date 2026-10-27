import { Agent as NativeAgent, type AgentComponent, type Config } from "@convex-dev/agent";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { Instructions, LanguageModel, StopCondition, ToolSet } from "ai";
import type { RunSettings } from "../component/run_settings.js";
import type { AgentExperiments, AgentHooks, ManagedAgent } from "./types.js";
type AgentOptions<Tools extends ToolSet> = Omit<Config, "languageModel"> & {
    name: string;
    languageModel: Extract<LanguageModel, string | LanguageModelV4>;
    instructions?: Instructions;
    tools?: Tools;
    stopWhen?: StopCondition<NoInfer<Tools>> | StopCondition<NoInfer<Tools>>[];
    /**
     * Agents this one may delegate to through the managed `agevex_delegate` tool.
     * Must be real `Agent` objects, not names: `registerAgent` resolves the
     * executable child through this list. Registration allows up to two edges
     * from each root (or one when limits.maxDepth is lowered).
     */
    subagents?: readonly ManagedAgent[];
    /**
     * Managed run policy, validated at registration and snapshotted at acceptance.
     * Defaults: stream, 4096 tokens, 90s model/tool deadlines, 16 model steps.
     * Bounds: tokens 1–32768, deadlines 1000–300000ms, steps 1–64; model +
     * 16*tool + 60000ms must fit the 30-minute Convex action ceiling. Generate
     * saves native messages/usage/tools/approvals without deltas. Direct native
     * calls stay unmanaged. runTurn requires the default Convex runtime (no
     * "use node"). A slice is capped at five minutes, plus 30s server margin;
     * 32k output may require a longer model timeout; each managed slice remains exactly one model call.
     */
    /** Human questions default to roots only; explicit true/false overrides both roles. */
    askUser?: boolean;
    run?: RunSettings;
    sandbox?: boolean;
    hooks?: AgentHooks;
    /** Managed turns cache Claude prefixes by default; this experimental policy may change. */
    experimental?: AgentExperiments;
};
declare const NativeBase: {
    new <CustomCtx extends object, Tools extends ToolSet>(component: AgentComponent, options: AgentOptions<Tools>): NativeAgent<CustomCtx, Tools>;
};
/** Native Agent plus metadata; generation, tools, threads and streams stay native. */
export declare class Agent<CustomCtx extends object = object, AgentTools extends ToolSet = any> extends NativeBase<CustomCtx, AgentTools> {
    /** Type-only marker: managed registration cannot supply required custom context. */
    readonly _agevexContext: (ctx: CustomCtx) => void;
    readonly name: string;
    /** Default model for tool-free background text tasks. */
    readonly textModel: AgentOptions<AgentTools>["languageModel"];
    /** Captured in the run snapshot; default resolves from the persisted assignment role. */
    readonly askUser?: boolean;
    readonly run?: RunSettings;
    readonly sandbox: boolean;
    readonly subagents: readonly ManagedAgent[];
    readonly hooks?: AgentHooks;
    readonly experimental?: AgentExperiments;
    /**
     * Native tools declared on this agent, kept so the managed runtime can merge
     * its reserved delegation tool with them. Inherited native behavior is
     * unchanged: a managed turn passes the merged set per call, exactly as the
     * native `streamText` `tools` override already allows.
     */
    readonly declaredTools: ToolSet;
    /** Internal view of the current native options, including host updates. */
    get _agevexProviderOptions(): ProviderOptions | undefined;
    constructor(component: AgentComponent, options: AgentOptions<AgentTools>);
}
export {};
