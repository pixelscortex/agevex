import { type ComponentApi, type DaytonaOptions } from "@daytona/convex";
import { type SandboxProvider } from "./types.js";
export type DaytonaSandboxOptions = DaytonaOptions & {
    autoStopInterval?: number;
    autoArchiveInterval?: number;
    snapshot?: string;
    target?: string;
};
/**
 * Daytona 2.1.0's host client owns lifecycle, exec and file writes
 * (src/client/index.ts:118-158,208-220,312-360). Only recovery
 * needs REST: src/component/daytona.ts:207-220 starts stopped/archived machines
 * but has no recover API for `error`. No credential enters our rows or jobs.
 *
 * Reads/listing use bounded Python through the component's run API because
 * files.ts:25-134 offers no byte/count bound; truncating AFTER that action
 * could already exceed Convex's return limit. Snapshots must include python3.
 * Never use runBackground: component/process.ts:427,491 schedules polls with
 * no deadline, including when the key disappears. Our only scheduled chain
 * is fenced by our jobs row; every provider interaction is a bounded run.
 */
export declare function daytona(component: ComponentApi, opts?: DaytonaSandboxOptions): SandboxProvider;
