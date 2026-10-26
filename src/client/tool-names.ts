// Reserved names of the managed collaboration tools.
//
// The SDK installs these tools itself on eligible turns (`turn/collaboration-tools.ts`).
// Registration rejects them in every agent's own tools (`registration/graph.ts`) and
// every turn rejects them in slot tool bags (`turn/tools.ts`), so merging a managed
// tool can never silently overwrite a host tool, and a host cannot impersonate one.
// `runtime.ts` re-exports the three names as part of the public API.

export const DELEGATE_TOOL_NAME = "agevex_delegate";
export const MESSAGE_CHILD_TOOL_NAME = "agevex_message_child";
export const ASK_PARENT_TOOL_NAME = "agevex_ask_parent";

/** Every reserved managed tool name, for collision checks. */
export const RESERVED_TOOL_NAMES: readonly string[] = [
  DELEGATE_TOOL_NAME,
  MESSAGE_CHILD_TOOL_NAME,
  ASK_PARENT_TOOL_NAME,
];
