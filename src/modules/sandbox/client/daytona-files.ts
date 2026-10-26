/**
 * Daytona files adapter operations.
 * The host provider factory binds these to one SDK client and validated settings.
 * Bounds are enforced inside the sandbox before data crosses Convex boundaries.
 */
import { type SandboxProvider, type FileEntry } from "./types.js";
import { type DaytonaContext, python, read } from "./daytona-context.js";
import { LIMITS, HARD_LIMITS, bounded, integer } from "../shared/limits.js";

/** Bind readFile to the provider client; retain its source-side bounds and effect policy. */
export function buildReadFile(runtime: DaytonaContext): SandboxProvider["readFile"] {
  const operation: Pick<SandboxProvider, "readFile"> = {
    async readFile(ctx, sandboxId, path, { maxBytes }) {
      return new TextDecoder().decode(await read(runtime, ctx, sandboxId, path, maxBytes, true));
    },
  };

  return operation.readFile;
}

/** Bind writeFile to the provider client; retain its source-side bounds and effect policy. */
export function buildWriteFile(runtime: DaytonaContext): SandboxProvider["writeFile"] {
  const { client } = runtime;

  const operation: Pick<SandboxProvider, "writeFile"> = {
    async writeFile(ctx, sandboxId, path, content) {
      bounded(path, LIMITS.pathChars, "PATH");

      if (content.length > HARD_LIMITS.writeChars) throw new Error("SANDBOX_WRITE_TOO_LARGE");

      await (await client()).writeFile(ctx, { sandboxId, path, content });
    },
  };

  return operation.writeFile;
}

/** Bind listFiles to the provider client; retain its source-side bounds and effect policy. */
export function buildListFiles(runtime: DaytonaContext): SandboxProvider["listFiles"] {
  const operation: Pick<SandboxProvider, "listFiles"> = {
    async listFiles(ctx, sandboxId, path, { limit }) {
      bounded(path, LIMITS.pathChars, "PATH");
      integer(limit, HARD_LIMITS.listEntries, "LIST_ENTRIES");

      const result = JSON.parse(
        await python(
          runtime,
          ctx,
          sandboxId,
          `import os,itertools,json\nwith os.scandir(${JSON.stringify(path)}) as d:\n print(json.dumps([{'name':e.name[:${LIMITS.pathChars}],'isDir':e.is_dir(follow_symlinks=False)} for e in itertools.islice(d,${limit})]))`,
        ),
      ) as FileEntry[];

      return result;
    },
  };

  return operation.listFiles;
}

/** Bind upload to the provider client; retain its source-side bounds and effect policy. */
export function buildUpload(runtime: DaytonaContext): SandboxProvider["upload"] {
  const { client } = runtime;

  const operation: Pick<SandboxProvider, "upload"> = {
    async upload(ctx, sandboxId, path, content) {
      bounded(path, LIMITS.pathChars, "PATH");

      if (content.byteLength > LIMITS.exportChunkBytes) throw new Error("SANDBOX_UPLOAD_TOO_LARGE");

      await (await client()).writeFileBytes(ctx, { sandboxId, path, content });
    },
  };

  return operation.upload;
}

/** Bind download to the provider client; retain its source-side bounds and effect policy. */
export function buildDownload(runtime: DaytonaContext): SandboxProvider["download"] {
  const { client } = runtime;

  const operation: Pick<SandboxProvider, "download"> = {
    async download(ctx, sandboxId, path, { maxBytes, offset = 0, totalSizeLimit = maxBytes }) {
      bounded(path, LIMITS.pathChars, "PATH");
      integer(maxBytes, LIMITS.exportChunkBytes, "EXPORT_WINDOW");
      integer(totalSizeLimit, HARD_LIMITS.exportBytesNode, "EXPORT_SIZE");
      integer(offset, HARD_LIMITS.exportBytesNode, "EXPORT_OFFSET", 0);

      // process.run records stdout in executions (process.ts:99-105), so
      // base64 stdout would leak file bytes into component mutation args and
      // rows. Stage one <=512 KiB window, return only its path, then use the
      // non-recording files.readFileBytes API (files.ts:61-74). This also
      // bounds that otherwise-unbounded file API BEFORE its action returns.
      const result = await python(
        runtime,
        ctx,
        sandboxId,
        `import os,stat,tempfile\nf=open(${JSON.stringify(path)},'rb')\ns=os.fstat(f.fileno())\nassert stat.S_ISREG(s.st_mode),'regular files only'\nif s.st_size>${totalSizeLimit}: print('TOO_LARGE')\nelse:\n os.makedirs(${JSON.stringify(LIMITS.exportRoot)},mode=0o700,exist_ok=True)\n fd,p=tempfile.mkstemp(dir=${JSON.stringify(LIMITS.exportRoot)})\n f.seek(${offset})\n with os.fdopen(fd,'wb') as out: out.write(f.read(${maxBytes}))\n print(p)`,
      );

      if (result.trim() === "TOO_LARGE") throw new Error("SANDBOX_EXPORT_TOO_LARGE");

      const windowPath = bounded(result.trim(), LIMITS.pathChars, "EXPORT_WINDOW_PATH");

      try {
        const bytes = new Uint8Array(
          await (await client()).readFileBytes(ctx, { sandboxId, path: windowPath }),
        );

        if (bytes.byteLength > maxBytes) throw new Error("SANDBOX_EXPORT_WINDOW_TOO_LARGE");

        return bytes;
      } finally {
        await (await client()).deleteFile(ctx, { sandboxId, path: windowPath });
      }
    },
  };

  return operation.download;
}
