/**
 * SDK tools and the agevex sandbox slot.
 * Effects use the core once-tool ledger; reads return bounded data without receipts.
 * The slot binds delegated calls to the root conversation while retaining the subject.
 */
import { type ToolExecutionOptions } from "ai";
import { type ToolContext } from "../../../client/once.js";
import { type SandboxSlot } from "../../../client/slots.js";
import { type RuntimeContext } from "./runtime-context.js";
/**
 * Plain SDK tools. Effects are bound by core's defineOnceTool ledger. Pure
 * reads accept trusted AI SDK `context` (or an explicit host ToolContext),
 * avoiding storing up to 640 KiB of file text in a 64 KiB receipt.
 *
 * `bind` chooses which trusted facts key the sandbox. It runs on every
 * ToolContext the tools see (once-tool body, key function and read
 * context), so no code path can reach a sandbox through unbound facts.
 */
export declare function buildTools(runtime: RuntimeContext, context: ToolContext | undefined, bind: (tc: ToolContext) => ToolContext): {
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
/** Standalone tools: the sandbox is keyed by the facts exactly as supplied. */
export declare function tools(runtime: RuntimeContext, context?: ToolContext): {
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
        onInputStart?: ((options: ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputDelta?: ((options: {
            inputTextDelta: string;
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
        onInputAvailable?: ((options: {
            input: {
                path: string;
            };
        } & ToolExecutionOptions<NoInfer<import("@ai-sdk/provider-utils").Context>>) => void | PromiseLike<void>) | undefined;
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
export declare function slot(runtime: RuntimeContext): SandboxSlot;
