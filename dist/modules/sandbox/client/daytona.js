/**
 * Public Daytona provider factory for the host installing the sandbox module.
 * Validates lifecycle settings and composes lifecycle, process and filesystem builders.
 * The SDK client owns credentials; component rows and scheduled args contain metadata only.
 */
import { buildCreate, buildResume, buildStop, buildDelete } from "./daytona-lifecycle.js";
import { buildExec, buildStartBackground, buildPoll, buildCancelBackground, } from "./daytona-process.js";
import { buildReadFile, buildWriteFile, buildListFiles, buildUpload, buildDownload, } from "./daytona-files.js";
import { Daytona } from "@daytona/convex";
import { LIMITS, bounded, integer } from "../shared/limits.js";
import {} from "./types.js";
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
export function daytona(component, opts = {}) {
    const autoStopInterval = integer(opts.autoStopInterval ?? LIMITS.daytonaAutoStopMinutes, LIMITS.daytonaTimerMaxMinutes, "AUTO_STOP", 0);
    const autoArchiveInterval = integer(opts.autoArchiveInterval ?? LIMITS.daytonaAutoArchiveMinutes, LIMITS.daytonaTimerMaxMinutes, "AUTO_ARCHIVE", 0);
    if (opts.snapshot !== undefined)
        bounded(opts.snapshot, LIMITS.identityChars, "SNAPSHOT");
    if (opts.target !== undefined)
        bounded(opts.target, LIMITS.identityChars, "TARGET");
    const client = new Daytona(component, opts);
    const runtime = { client, opts, autoStopInterval, autoArchiveInterval };
    return {
        id: "daytona",
        create: buildCreate(runtime),
        resume: buildResume(runtime),
        stop: buildStop(runtime),
        delete: buildDelete(runtime),
        exec: buildExec(runtime),
        startBackground: buildStartBackground(runtime),
        poll: buildPoll(runtime),
        cancelBackground: buildCancelBackground(runtime),
        readFile: buildReadFile(runtime),
        writeFile: buildWriteFile(runtime),
        listFiles: buildListFiles(runtime),
        upload: buildUpload(runtime),
        download: buildDownload(runtime),
    };
}
