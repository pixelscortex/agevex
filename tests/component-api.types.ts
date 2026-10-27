/**
 * Type-level guarantee for the checked-in component bridges (`_generated/component.ts`):
 * a host sees a component's public functions and never its internal ones. Checked by
 * `bun run typecheck:tests`; nothing here runs.
 */
import type { ComponentApi as Core } from "../src/component/_generated/component.js";
import type { ComponentApi as Extract } from "../src/modules/extract/component/_generated/component.js";

type Has<T, K extends PropertyKey> = K extends keyof T ? true : false;

// Public functions cross the mount boundary.
export const corePublic: Has<Core["turns"]["send"], "accept"> = true;

// Internal Workflow/maintenance functions stay private.
export const coreInternal: Has<Core["turns"]["slices"], "betweenSlices"> = false;

export const extractInternal: Has<Extract["artifacts"], "expire"> = false;
