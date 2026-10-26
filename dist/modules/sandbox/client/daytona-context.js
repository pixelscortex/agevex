/**
 * Shared Daytona adapter context and bounded Python transport.
 * Lifecycle, process and file builders share one SDK client.
 * This host-only bridge never puts credentials in component rows or scheduled args.
 */
import { Daytona } from "@daytona/convex";
import { resolveCredential } from "./credential.js";
import {} from "./types.js";
import { LIMITS, HARD_LIMITS, bounded, integer } from "../shared/limits.js";
/**
 * Build the per-call key resolver and SDK client factory. Nothing reads env or
 * calls a getter here: an unset `apiKey` keeps the SDK's own call-time env
 * fallback, and `apiKey()` (REST recovery) falls back the same way when called.
 */
export function bindCredentials(component, opts) {
    const { apiKey: configured, ...rest } = opts;
    const apiKey = async () => resolveCredential(configured ?? process.env.DAYTONA_API_KEY ?? "", "SANDBOX_DAYTONA_KEY_REQUIRED");
    const client = async () => new Daytona(component, configured === undefined
        ? rest
        : { ...rest, apiKey: await resolveCredential(configured, "SANDBOX_DAYTONA_KEY_REQUIRED") });
    return { client, apiKey };
}
/** Quote Python source as one shell argument without interpreting embedded quotes. */
function quote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
/** Decode a byte-bounded Python response without a second provider read. */
export function decodeBase64(value) {
    return Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
}
/** Run one bounded Python operation; provider failures stay visible to the caller. */
export async function python(runtime, ctx, sandboxId, source, timeoutS = LIMITS.commandTimeoutS) {
    const client = await runtime.client();
    const result = await client.run(ctx, {
        sandboxId,
        command: `python3 -c ${quote(source)}`,
        timeoutSeconds: timeoutS,
        autoStart: false,
    });
    if (result.exitCode !== 0)
        throw new Error("SANDBOX_DAYTONA_OPERATION_FAILED");
    return result.result;
}
/** Bound regular-file text reads at the source, before the component receives bytes. */
export async function read(runtime, ctx, sandboxId, path, maxBytes, tail) {
    bounded(path, LIMITS.pathChars, "PATH");
    integer(maxBytes, HARD_LIMITS.fileReadChars * LIMITS.utf8BytesPerChar, "FILE_BYTES");
    // Read <=maxBytes+1, even if the file grows after the size check. Export
    // refuses overflow, while text reads retain the tail. The largest reply
    // is ceil(640000/3)*4 <854 KiB base64, below Convex's return ceiling.
    const result = await python(runtime, ctx, sandboxId, `import os,stat,base64\np=${JSON.stringify(path)}\nn=${maxBytes}\nf=open(p,'rb')\ns=os.fstat(f.fileno())\nassert stat.S_ISREG(s.st_mode),'regular files only'\n${tail ? "f.seek(max(0,s.st_size-n))" : "assert s.st_size<=n,'file too large'"}\nb=f.read(n+1)\nassert len(b)<=n,'file too large'\nprint(base64.b64encode(b).decode())`);
    const bytes = decodeBase64(result.trim());
    if (bytes.byteLength > maxBytes)
        throw new Error("SANDBOX_FILE_TOO_LARGE");
    return bytes;
}
