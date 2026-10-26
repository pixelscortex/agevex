/* eslint-disable */
/**
 * Offline equivalent of Convex's generated component surface. Only public
 * component functions cross the mount boundary; internal Workflow functions
 * stay private. Component-local branded ids become strings in the host app.
 * Deriving the signatures keeps this checked-in bridge in sync until the next
 * deployment runs normal component codegen.
 */
import type { ApiFromModules, FunctionReference } from "convex/server";
import type { GenericId } from "convex/values";
import type * as text_state from "../text/state.js";
import type * as text_requests from "../text/requests.js";
import type * as files_attachments from "../files/attachments.js";
import type * as hooks_notes from "../hooks/notes.js";
import type * as hooks_origins from "../hooks/origins.js";
import type * as hooks_reviews from "../hooks/reviews.js";
import type * as hooks_routing from "../hooks/routing.js";
import type * as hooks_state from "../hooks/state.js";
import type * as receipts_effects from "../receipts/effects.js";
import type * as subagents_deliver from "../subagents/deliver.js";
import type * as subagents_history from "../subagents/history.js";
import type * as subagents_launch from "../subagents/launch.js";
import type * as subagents_messages from "../subagents/messages.js";
import type * as subagents_settle from "../subagents/settle.js";
import type * as turns_approvals from "../turns/approvals.js";
import type * as turns_cancel from "../turns/cancel.js";
import type * as turns_failures from "../turns/failures.js";
import type * as turns_send from "../turns/send.js";
import type * as turns_slices from "../turns/slices.js";

type Wire<T> = T extends GenericId<string>
  ? string
  : T extends readonly unknown[]
    ? { [K in keyof T]: Wire<T[K]> }
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

type Exposed<T, Name extends string | undefined> = {
  [K in keyof T as T[K] extends FunctionReference<any, "public">
    ? K
    : T[K] extends FunctionReference<any, any>
      ? never
      : K]: T[K] extends FunctionReference<infer Type, "public", infer Args, infer Result>
    ? FunctionReference<Type, "internal", Wire<Args>, Wire<Result>, Name>
    : Exposed<T[K], Name>;
};

export type ComponentApi<Name extends string | undefined = string | undefined> = Exposed<
  ApiFromModules<{
    "text/state": typeof text_state;
"text/requests": typeof text_requests;
    "files/attachments": typeof files_attachments;
    "hooks/notes": typeof hooks_notes;
    "hooks/origins": typeof hooks_origins;
    "hooks/reviews": typeof hooks_reviews;
    "hooks/routing": typeof hooks_routing;
    "hooks/state": typeof hooks_state;
    "receipts/effects": typeof receipts_effects;
    "subagents/deliver": typeof subagents_deliver;
    "subagents/history": typeof subagents_history;
    "subagents/launch": typeof subagents_launch;
    "subagents/messages": typeof subagents_messages;
    "subagents/settle": typeof subagents_settle;
    "turns/approvals": typeof turns_approvals;
    "turns/cancel": typeof turns_cancel;
    "turns/failures": typeof turns_failures;
    "turns/send": typeof turns_send;
    "turns/slices": typeof turns_slices;
  }>,
  Name
>;
