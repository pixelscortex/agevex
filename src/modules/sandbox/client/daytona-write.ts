/**
 * Daytona binary stages use the SDK's binary upload plus bounded Python filesystem operations.
 * Commands contain paths/metadata only; bytes never enter execution stdout or command records.
 */
import type { SandboxProvider } from "./types.js";
import { python, type DaytonaContext } from "./daytona-context.js";
import { LIMITS, bounded } from "../shared/limits.js";
import { SandboxWriteError, validateWriteCommit, validateWriteWindow } from "../shared/write.js";

/** Stage one window with offset checking; exact duplicates never append twice. */
export function buildWriteWindow(runtime: DaytonaContext): SandboxProvider["writeWindow"] {
  return async (ctx, sandboxId, tempPath, offset, bytes) => {
    validateWriteWindow(tempPath, offset, bytes);
    const windowPath = bounded(`${tempPath}.window`, LIMITS.pathChars, "PATH");

    // @daytona/convex 2.1.0 src/client/index.ts:342-362 copies the exact view,
    // and component/files.ts:78-91 uploads binary without recording executions.
    // At most 512 KiB crosses that action boundary, below its argument ceiling.
    try {
      await (
        await runtime.client()
      ).writeFileBytes(ctx, { sandboxId, path: windowPath, content: bytes });

      const result = await python(
        runtime,
        ctx,
        sandboxId,
        `import os,stat,fcntl
p=${JSON.stringify(tempPath)}
with open(${JSON.stringify(windowPath)},'rb') as w:
 assert stat.S_ISREG(os.fstat(w.fileno()).st_mode)
 b=w.read(${LIMITS.exportChunkBytes + 1})
assert len(b)==${bytes.byteLength}
fd=os.open(p,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'r+b') as f:
 fcntl.flock(f,fcntl.LOCK_EX)
 s=os.fstat(f.fileno())
 assert stat.S_ISREG(s.st_mode)
 try: current=os.stat(p,follow_symlinks=False)
 except FileNotFoundError: print('OFFSET'); raise SystemExit
 if (current.st_dev,current.st_ino)!=(s.st_dev,s.st_ino): print('OFFSET'); raise SystemExit
 n=s.st_size
 if n==${offset}:
  f.seek(n); f.write(b); f.flush(); os.fsync(f.fileno()); print('OK')
 elif n>=${offset + bytes.byteLength}:
  f.seek(${offset}); print('OK' if f.read(len(b))==b else 'OFFSET')
 else: print('OFFSET')`,
      );

      if (result.trim() !== "OK") throw new SandboxWriteError("SANDBOX_WRITE_OFFSET_MISMATCH");
    } finally {
      // Also removed by discardWrite after a host interruption. Fixed names
      // leave at most one stage + one window per target, without directory scans.
      await python(
        runtime,
        ctx,
        sandboxId,
        `import os
try: os.unlink(${JSON.stringify(windowPath)})
except FileNotFoundError: pass`,
      );
    }
  };
}

/** Hash bounded windows before atomic rename; a wrong size/hash can never replace the target. */
export function buildCommitWrite(runtime: DaytonaContext): SandboxProvider["commitWrite"] {
  return async (ctx, sandboxId, tempPath, path, expected) => {
    validateWriteCommit(tempPath, path, expected.bytes, expected.sha256);

    const result = await python(
      runtime,
      ctx,
      sandboxId,
      `import os,stat,fcntl,hashlib
p=${JSON.stringify(tempPath)}
try: fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW)
except FileNotFoundError: print('INCOMPLETE'); raise SystemExit
with os.fdopen(fd,'r+b') as f:
 fcntl.flock(f,fcntl.LOCK_EX)
 s=os.fstat(f.fileno())
 assert stat.S_ISREG(s.st_mode)
 try: current=os.stat(p,follow_symlinks=False)
 except FileNotFoundError: print('INCOMPLETE'); raise SystemExit
 if (current.st_dev,current.st_ino)!=(s.st_dev,s.st_ino): print('INCOMPLETE'); raise SystemExit
 if s.st_size!=${expected.bytes}: print('INCOMPLETE')
 else:
  h=hashlib.sha256()
  left=${expected.bytes}
  while left:
   b=f.read(min(left,${LIMITS.exportChunkBytes}))
   if not b: break
   h.update(b); left-=len(b)
  if left or h.hexdigest()!=${JSON.stringify(expected.sha256)}: print('INCOMPLETE')
  else:
   os.fsync(f.fileno()); os.replace(p,${JSON.stringify(path)}); print('OK')`,
    );

    if (result.trim() !== "OK") throw new SandboxWriteError("SANDBOX_WRITE_INCOMPLETE");
  };
}

/** Idempotent cleanup reclaims both interrupted SDK uploads and incomplete stages. */
export function buildDiscardWrite(runtime: DaytonaContext): SandboxProvider["discardWrite"] {
  return async (ctx, sandboxId, tempPath) => {
    bounded(tempPath, LIMITS.pathChars, "PATH");
    bounded(`${tempPath}.window`, LIMITS.pathChars, "PATH");

    // A retry may overlap a timed-out provider call. Taking the same inode lock
    // as append/commit prevents cleanup from replacing a stage during hashing;
    // inode checks reject handles opened before an earlier cleanup/rename.
    await python(
      runtime,
      ctx,
      sandboxId,
      `import os,fcntl
for p in [${JSON.stringify(tempPath)},${JSON.stringify(`${tempPath}.window`)}]:
 try: fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW)
 except FileNotFoundError: continue
 with os.fdopen(fd,'r+b') as f:
  fcntl.flock(f,fcntl.LOCK_EX)
  try: s=os.stat(p,follow_symlinks=False)
  except FileNotFoundError: continue
  original=os.fstat(f.fileno())
  if (s.st_dev,s.st_ino)==(original.st_dev,original.st_ino): os.unlink(p)`,
    );
  };
}
