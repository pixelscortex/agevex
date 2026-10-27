// The managed collaboration tools the SDK installs on eligible turns.
//
// `agevex_delegate` and `agevex_message_child` exist on turns of agents that have
// child edges; `agevex_ask_parent` and `agevex_message_parent` on delegated children. Each tool is a
// thin call to the coordinator mutation (`coordinate/`) under the turn's fence,
// carrying the turn's capability (assignment + turn token + native tool call id).
// They record `delegated` / `asked` on the generation, which decides how the turn
// ends (`turn/completion.ts`).
import { tool } from "ai";
import { z } from "zod";
import { coordinateRef } from "../registration/context.js";
import { ASK_PARENT_TOOL_NAME, DELEGATE_TOOL_NAME, MESSAGE_CHILD_TOOL_NAME, MESSAGE_PARENT_TOOL_NAME, } from "../tool-names.js";
/** What the model (or a `beforeDelegate` rewrite) may pass to `agevex_delegate`. */
const delegateInput = z.object({
    agent: z.string(),
    task: z.string(),
    wait: z.literal("each").optional(),
});
/** Install the collaboration tools this turn is eligible for into `tools`. */
export function installCollaborationTools(rt, gen, tools, eligible) {
    if (eligible)
        tools[DELEGATE_TOOL_NAME] = delegateTool(rt, gen);
    if (eligible)
        tools[MESSAGE_CHILD_TOOL_NAME] = messageChildTool(rt, gen);
    if (gen.turn.child)
        tools[ASK_PARENT_TOOL_NAME] = askParentTool(rt, gen);
    if (gen.turn.child)
        tools[MESSAGE_PARENT_TOOL_NAME] = messageParentTool(rt, gen);
}
/** Report progress without changing the child's continuation or completion state. */
function messageParentTool(rt, gen) {
    const { args } = gen.turn;
    return tool({
        description: `Send your immediate parent a short progress message and keep working. No answer is required. At most 2 KiB, at least 5 seconds between accepted messages, and at most ${rt.limits.parentNotesPerChild} accepted notes over this child run. Your final result always reaches the parent and has a hop reserved for it.`,
        inputSchema: z.object({ text: z.string() }),
        execute: (input, options) => gen.fence.ctx.runMutation(coordinateRef(rt), {
            op: "message_parent",
            assignmentId: args.assignmentId,
            turnToken: args.turnToken,
            toolCallId: options.toolCallId,
            text: input.text,
        }),
    });
}
/**
 * `agevex_delegate`: launch one child run. `beforeDelegate` may block it (a
 * `HOOK_BLOCKED` denial) or rewrite its input, which is re-validated.
 */
function delegateTool(rt, gen) {
    const { turn, hc, hook, fence, state } = gen;
    const { args, managed } = turn;
    return tool({
        description: "Delegate one bounded task to a registered child agent. Its result arrives later. A result continuation may delegate again within the same run budget. On RESULTS_PENDING, wait for or claim child results before launching more.",
        inputSchema: delegateInput,
        execute: async (input, options) => {
            const before = await hook(managed.hooks?.beforeDelegate
                ? () => managed.hooks.beforeDelegate(hc, {
                    agent: input.agent,
                    task: input.task,
                })
                : undefined);
            if (before?.block)
                return { status: "denied", code: "HOOK_BLOCKED", reason: before.block };
            const rewritten = before && "input" in before ? await delegateInput.parseAsync(before.input) : input;
            const launch = await fence.ctx.runMutation(coordinateRef(rt), {
                op: "launch",
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
                toolCallId: options.toolCallId,
                agent: rewritten.agent,
                task: rewritten.task,
                wait: rewritten.wait,
            });
            if (launch?.status === "queued")
                state.delegated = true;
            return launch;
        },
    });
}
/** `agevex_message_child`: a bounded follow-up or answer to a running child. */
function messageChildTool(rt, gen) {
    const { args } = gen.turn;
    return tool({
        description: "Send a bounded follow-up or answer to one of your own child runs. Finished runs refuse messages.",
        inputSchema: z.object({
            runId: z.string(),
            text: z.string().max(rt.limits.taskLength),
        }),
        execute: (input) => gen.fence.ctx.runMutation(coordinateRef(rt), {
            op: "message",
            assignmentId: args.assignmentId,
            turnToken: args.turnToken,
            ...input,
        }),
    });
}
/** `agevex_ask_parent`: a child's one open question; the child pauses until answered. */
function askParentTool(rt, gen) {
    const { args } = gen.turn;
    return tool({
        description: "Ask your parent one question and pause until it answers with message_child. Only one question may be open.",
        inputSchema: z.object({ question: z.string().max(rt.limits.taskLength) }),
        execute: async (input) => {
            const response = await gen.fence.ctx.runMutation(coordinateRef(rt), {
                op: "ask",
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
                ...input,
            });
            if (response?.status === "accepted")
                gen.state.asked = true;
            return response;
        },
    });
}
