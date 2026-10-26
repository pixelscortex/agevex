/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as cancellation_cleanup from "../cancellation/cleanup.js";
import type * as text_jobs from "../text/jobs.js";
import type * as text_state from "../text/state.js";
import type * as text_requests from "../text/requests.js";
import type * as text_worker from "../text/worker.js";
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
import type * as turns_loop from "../turns/loop.js";
import type * as turns_send from "../turns/send.js";
import type * as turns_slices from "../turns/slices.js";
import type * as workflows_lanes from "../workflows/lanes.js";
import type * as workflows_worker from "../workflows/worker.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  "cancellation/cleanup": typeof cancellation_cleanup;
  "text/jobs": typeof text_jobs;
"text/state": typeof text_state;
"text/requests": typeof text_requests;
"text/worker": typeof text_worker;
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
  "turns/loop": typeof turns_loop;
  "turns/send": typeof turns_send;
  "turns/slices": typeof turns_slices;
  "workflows/lanes": typeof workflows_lanes;
  "workflows/worker": typeof workflows_worker;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  rootWorkflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"rootWorkflow">;
  childWorkflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"childWorkflow">;
};
