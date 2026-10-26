/**
 * Public host entry point for the optional sandbox component.
 * Wires validated runtime context into lifecycle, tools and watchdog builders.
 * Hosts retain authorization, provider configuration and completion callbacks.
 */
import { type GenericMutationCtx, type GenericDataModel } from "convex/server";
import { type ToolContext } from "../../../client/once.js";
import { type SandboxCompletion } from "../../../client/index.js";
import { type SandboxCall, type SandboxContext, type SandboxFacts, type SandboxOptions, type PollArgs, type SandboxExportArgs, type SandboxExportResult } from "./types.js";
/**
 * Connect a finished background job to agevex: pass the result as
 * `defineSandbox({ onComplete: sandboxCompletion(() => runtime) })`, where
 * `runtime` is the `registerAgent` result (a thunk, because the sandbox is
 * created before the runtime that uses its slot).
 *
 * The callback runs inside the sandbox's own terminal-state transaction, so the
 * note and the job transition commit or roll back together. Core's
 * `sandboxComplete` re-authorizes the stored owner and posts a passive note
 * (delivered at the next safe turn claim). The payload is bounded here, not
 * trusted to the provider: the log keeps its tail within
 * LIMITS.completionLogChars, and an exit code outside the range core accepts is
 * dropped, because core would reject it, roll back the settlement and leave
 * the job retrying until its deadline.
 */
export declare function sandboxCompletion(runtime: {
    sandboxComplete(ctx: GenericMutationCtx<GenericDataModel>, event: SandboxCompletion): unknown;
} | (() => {
    sandboxComplete(ctx: GenericMutationCtx<GenericDataModel>, event: SandboxCompletion): unknown;
})): NonNullable<SandboxOptions["onComplete"]>;
/**
 * Bind sandboxes to trusted request facts. Mount this optional component on its
 * own; core and the Agent component never depend on its schema. Public host
 * endpoints must call these helpers rather than exposing component references.
 */
export declare function defineSandbox(options: SandboxOptions): {
    limits: {
        readonly cleanupBatch: number;
        readonly ttl: number;
        readonly pollMinMs: number;
        readonly pollMaxMs: number;
        readonly commandTimeoutS: number;
        readonly outputChars: number;
        readonly fileReadChars: number;
        readonly writeChars: number;
        readonly listEntries: number;
        readonly exportBytes: number;
        readonly exportBytesNode: number;
        readonly jobTimeoutMs: number;
        readonly jobsPerSandbox: number;
    };
    tools: (context?: ToolContext) => {
        sandbox_exec: import("ai").Tool<{
            command: string;
        }, {
            status: "done";
            exitCode: number;
            timedOut: boolean;
            stdout: string;
            stderr: string;
            truncated: boolean;
        } | {
            status: "unknown";
            exitCode?: undefined;
            timedOut?: undefined;
            stdout?: undefined;
            stderr?: undefined;
            truncated?: undefined;
        }>;
        sandbox_read_file: ({
            deferLoading?: boolean;
            title?: string;
            providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
            metadata?: import("@ai-sdk/provider").JSONObject;
            inputSchema: import("ai").FlexibleSchema<{
                path: string;
            }>;
            contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
            needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
                path: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
            onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputDelta?: ((options: {
                inputTextDelta: string;
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputAvailable?: ((options: {
                input: {
                    path: string;
                };
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            toModelOutput?: ((options: {
                toolCallId: string;
                input: {
                    path: string;
                };
                output: NoInfer<{
                    content: string;
                }>;
            }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
        } & {
            outputSchema?: import("ai").FlexibleSchema<{
                content: string;
            }> | undefined;
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                content: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        } & {
            description?: string | ((options: {
                context: NoInfer<import("@ai-sdk/provider-utils").Context>;
                experimental_sandbox?: import("ai").Experimental_SandboxSession;
            }) => string) | undefined;
            strict?: boolean;
            inputExamples?: {
                input: NoInfer<{
                    path: string;
                }>;
            }[] | undefined;
            id?: never;
            isProviderExecuted?: never;
            args?: never;
            supportsDeferredResults?: never;
        } & {
            type?: undefined | "function";
        } & {
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                content: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        }) | ({
            deferLoading?: boolean;
            title?: string;
            providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
            metadata?: import("@ai-sdk/provider").JSONObject;
            inputSchema: import("ai").FlexibleSchema<{
                path: string;
            }>;
            contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
            needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
                path: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
            onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputDelta?: ((options: {
                inputTextDelta: string;
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputAvailable?: ((options: {
                input: {
                    path: string;
                };
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            toModelOutput?: ((options: {
                toolCallId: string;
                input: {
                    path: string;
                };
                output: NoInfer<{
                    content: string;
                }>;
            }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
        } & {
            outputSchema?: import("ai").FlexibleSchema<{
                content: string;
            }> | undefined;
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                content: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        } & {
            description?: string | ((options: {
                context: NoInfer<import("@ai-sdk/provider-utils").Context>;
                experimental_sandbox?: import("ai").Experimental_SandboxSession;
            }) => string) | undefined;
            strict?: boolean;
            inputExamples?: {
                input: NoInfer<{
                    path: string;
                }>;
            }[] | undefined;
            id?: never;
            isProviderExecuted?: never;
            args?: never;
            supportsDeferredResults?: never;
        } & {
            type: "dynamic";
        } & {
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                content: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        }) | ({
            deferLoading?: boolean;
            title?: string;
            providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
            metadata?: import("@ai-sdk/provider").JSONObject;
            inputSchema: import("ai").FlexibleSchema<{
                path: string;
            }>;
            contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
            needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
                path: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
            onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputDelta?: ((options: {
                inputTextDelta: string;
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputAvailable?: ((options: {
                input: {
                    path: string;
                };
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            toModelOutput?: ((options: {
                toolCallId: string;
                input: {
                    path: string;
                };
                output: NoInfer<{
                    content: string;
                }>;
            }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
        } & {
            outputSchema?: import("ai").FlexibleSchema<{
                content: string;
            }> | undefined;
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                content: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        } & {
            type: "provider";
            id: `${string}.${string}`;
            args: Record<string, unknown>;
            description?: never;
            strict?: never;
            inputExamples?: never;
        } & {
            isProviderExecuted: false;
            supportsDeferredResults?: never;
        } & {
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                content: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        }) | ({
            deferLoading?: boolean;
            title?: string;
            providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
            metadata?: import("@ai-sdk/provider").JSONObject;
            inputSchema: import("ai").FlexibleSchema<{
                path: string;
            }>;
            contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
            needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
                path: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
            onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputDelta?: ((options: {
                inputTextDelta: string;
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputAvailable?: ((options: {
                input: {
                    path: string;
                };
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            toModelOutput?: ((options: {
                toolCallId: string;
                input: {
                    path: string;
                };
                output: NoInfer<{
                    content: string;
                }>;
            }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
        } & {
            outputSchema?: import("ai").FlexibleSchema<{
                content: string;
            }> | undefined;
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                content: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        } & {
            type: "provider";
            id: `${string}.${string}`;
            args: Record<string, unknown>;
            description?: never;
            strict?: never;
            inputExamples?: never;
        } & {
            isProviderExecuted: true;
            supportsDeferredResults?: boolean;
        } & {
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                content: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        });
        sandbox_write_file: import("ai").Tool<{
            path: string;
            content: string;
        }, {
            status: "done";
        } | {
            status: "unknown";
        }>;
        sandbox_list: ({
            deferLoading?: boolean;
            title?: string;
            providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
            metadata?: import("@ai-sdk/provider").JSONObject;
            inputSchema: import("ai").FlexibleSchema<{
                path: string;
            }>;
            contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
            needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
                path: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
            onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputDelta?: ((options: {
                inputTextDelta: string;
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputAvailable?: ((options: {
                input: {
                    path: string;
                };
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            toModelOutput?: ((options: {
                toolCallId: string;
                input: {
                    path: string;
                };
                output: NoInfer<{
                    entries: {
                        size?: number | undefined;
                        name: string;
                        isDir: boolean;
                    }[];
                }>;
            }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
        } & {
            outputSchema?: import("ai").FlexibleSchema<{
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }> | undefined;
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        } & {
            description?: string | ((options: {
                context: NoInfer<import("@ai-sdk/provider-utils").Context>;
                experimental_sandbox?: import("ai").Experimental_SandboxSession;
            }) => string) | undefined;
            strict?: boolean;
            inputExamples?: {
                input: NoInfer<{
                    path: string;
                }>;
            }[] | undefined;
            id?: never;
            isProviderExecuted?: never;
            args?: never;
            supportsDeferredResults?: never;
        } & {
            type?: undefined | "function";
        } & {
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        }) | ({
            deferLoading?: boolean;
            title?: string;
            providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
            metadata?: import("@ai-sdk/provider").JSONObject;
            inputSchema: import("ai").FlexibleSchema<{
                path: string;
            }>;
            contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
            needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
                path: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
            onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputDelta?: ((options: {
                inputTextDelta: string;
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputAvailable?: ((options: {
                input: {
                    path: string;
                };
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            toModelOutput?: ((options: {
                toolCallId: string;
                input: {
                    path: string;
                };
                output: NoInfer<{
                    entries: {
                        size?: number | undefined;
                        name: string;
                        isDir: boolean;
                    }[];
                }>;
            }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
        } & {
            outputSchema?: import("ai").FlexibleSchema<{
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }> | undefined;
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        } & {
            description?: string | ((options: {
                context: NoInfer<import("@ai-sdk/provider-utils").Context>;
                experimental_sandbox?: import("ai").Experimental_SandboxSession;
            }) => string) | undefined;
            strict?: boolean;
            inputExamples?: {
                input: NoInfer<{
                    path: string;
                }>;
            }[] | undefined;
            id?: never;
            isProviderExecuted?: never;
            args?: never;
            supportsDeferredResults?: never;
        } & {
            type: "dynamic";
        } & {
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        }) | ({
            deferLoading?: boolean;
            title?: string;
            providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
            metadata?: import("@ai-sdk/provider").JSONObject;
            inputSchema: import("ai").FlexibleSchema<{
                path: string;
            }>;
            contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
            needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
                path: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
            onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputDelta?: ((options: {
                inputTextDelta: string;
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputAvailable?: ((options: {
                input: {
                    path: string;
                };
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            toModelOutput?: ((options: {
                toolCallId: string;
                input: {
                    path: string;
                };
                output: NoInfer<{
                    entries: {
                        size?: number | undefined;
                        name: string;
                        isDir: boolean;
                    }[];
                }>;
            }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
        } & {
            outputSchema?: import("ai").FlexibleSchema<{
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }> | undefined;
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        } & {
            type: "provider";
            id: `${string}.${string}`;
            args: Record<string, unknown>;
            description?: never;
            strict?: never;
            inputExamples?: never;
        } & {
            isProviderExecuted: false;
            supportsDeferredResults?: never;
        } & {
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        }) | ({
            deferLoading?: boolean;
            title?: string;
            providerOptions?: import("@ai-sdk/provider-utils").ProviderOptions;
            metadata?: import("@ai-sdk/provider").JSONObject;
            inputSchema: import("ai").FlexibleSchema<{
                path: string;
            }>;
            contextSchema?: import("ai").FlexibleSchema<import("@ai-sdk/provider-utils").Context> | undefined;
            needsApproval?: boolean | import("@ai-sdk/provider-utils").ToolNeedsApprovalFunction<{
                path: string;
            }, NoInfer<import("@ai-sdk/provider-utils").Context>> | undefined;
            onInputStart?: ((options: import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputDelta?: ((options: {
                inputTextDelta: string;
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            onInputAvailable?: ((options: {
                input: {
                    path: string;
                };
            } & import("ai").ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
            toModelOutput?: ((options: {
                toolCallId: string;
                input: {
                    path: string;
                };
                output: NoInfer<{
                    entries: {
                        size?: number | undefined;
                        name: string;
                        isDir: boolean;
                    }[];
                }>;
            }) => import("@ai-sdk/provider-utils").ToolResultOutput | PromiseLike<import("@ai-sdk/provider-utils").ToolResultOutput>) | undefined;
        } & {
            outputSchema?: import("ai").FlexibleSchema<{
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }> | undefined;
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        } & {
            type: "provider";
            id: `${string}.${string}`;
            args: Record<string, unknown>;
            description?: never;
            strict?: never;
            inputExamples?: never;
        } & {
            isProviderExecuted: true;
            supportsDeferredResults?: boolean;
        } & {
            execute: import("ai").ToolExecuteFunction<{
                path: string;
            }, {
                entries: {
                    size?: number | undefined;
                    name: string;
                    isDir: boolean;
                }[];
            }, NoInfer<import("@ai-sdk/provider-utils").Context>>;
        });
        sandbox_run_background: import("ai").Tool<{
            command: string;
        }, {
            status: "running";
            jobId: string;
        } | {
            status: "unknown";
            jobId: string;
        }>;
    };
    slot: () => import("../../../client/slots.js").SandboxSlot;
    scopeKey: (tc: SandboxFacts) => Promise<string>;
    prepare: (tc: SandboxCall, opts?: {
        existingOnly?: boolean;
    }) => Promise<{
        sandboxId: string;
        scopeKey: string;
        claim: string;
    }>;
    readFile: (tc: SandboxCall, input: {
        path: string;
    }) => Promise<{
        content: string;
    }>;
    list: (tc: SandboxCall, input: {
        path: string;
    }) => Promise<{
        entries: {
            size?: number | undefined;
            name: string;
            isDir: boolean;
        }[];
    }>;
    internalFunctions: () => {
        wake: import("convex/server").RegisteredMutation<"internal", PollArgs, Promise<null>>;
        poll: import("convex/server").RegisteredAction<"internal", import("./types.js").PollActionArgs, Promise<null>>;
        settle: import("convex/server").RegisteredMutation<"internal", import("./types.js").SettleArgs, Promise<null>>;
        cleanup: import("convex/server").RegisteredAction<"internal", {}, Promise<null>>;
    };
    job: (ctx: SandboxContext, input: PollArgs) => Promise<{
        code?: "SANDBOX_JOB_DEADLINE" | undefined;
        logTail?: string | undefined;
        exitCode?: number | undefined;
        providerJobId?: string | undefined;
        state: "failed" | "running" | "done" | "unknown" | "starting";
        subject: string;
        threadId: string;
        runId: string;
        jobId: string;
        scopeKey: string;
    } | null>;
    cleanup: (ctx: SandboxContext) => Promise<import("convex/values").GenericId<"_scheduled_functions">>;
    forget: (ctx: SandboxContext, input: SandboxFacts) => Promise<boolean>;
    delete: (tc: SandboxCall) => Promise<void>;
    stop: (tc: SandboxCall) => Promise<void>;
    export: (ctx: SandboxContext, input: SandboxExportArgs) => Promise<SandboxExportResult>;
};
/** Export this action from a host "use node" file to opt into the 512 MiB runtime. */
export declare function sandboxNodeExport(options: SandboxOptions): import("convex/server").RegisteredAction<"internal", {
    threadId: string;
    path: string;
}, Promise<SandboxExportResult>>;
export { daytona } from "./daytona.js";
export { LIMITS, HARD_LIMITS } from "../shared/limits.js";
export type { SandboxLimits } from "../shared/limits.js";
export type * from "./types.js";
export type { ComponentApi } from "../component/_generated/component.js";
