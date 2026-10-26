/**
 * Daytona binary stages use the SDK's binary upload plus bounded Python filesystem operations.
 * Commands contain paths/metadata only; bytes never enter execution stdout or command records.
 */
import type { SandboxProvider } from "./types.js";
import { python, type DaytonaContext } from "./daytona-context.js";
import { HARD_LIMITS, LIMITS, bounded, integer } from "../shared/limits.js";
import { SandboxWriteError, validateWriteCommit, validateWriteWindow } from "../shared/write.js";

/** Stage one window with offset checking; exact duplicates never append twice. */
export function buildWriteWindow(runtime: DaytonaContext): SandboxProvider["writeWindow"] {
  return async (ctx, sandboxId, tempPath, offset, bytes) => {
    validateWriteWindow(tempPath, offset, bytes);
    const windowPath = bounded(`${tempPath}.window`, LIMITS.pathChars, "PATH");

    // @daytona/convex 2.1.0 src/client/index.ts:342-362 copies the exact view,
    // and component/files.ts:78-91 uploads binary without recording executions.
    // At most 512 KiB crosses that action boundary, below its argument ceiling.
    // Two round trips per window: upload, then one script that appends and
    // removes the window once its bytes are safely in the stage.
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
q=${JSON.stringify(windowPath)}
with open(q,'rb') as w:
 assert stat.S_ISREG(os.fstat(w.fileno()).st_mode)
 b=w.read(${LIMITS.exportChunkBytes + 1})
assert len(b)==${bytes.byteLength}
r='OFFSET'
fd=os.open(p,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o666)
with os.fdopen(fd,'r+b') as f:
 fcntl.flock(f,fcntl.LOCK_EX)
 s=os.fstat(f.fileno())
 assert stat.S_ISREG(s.st_mode)
 try: current=os.stat(p,follow_symlinks=False)
 except FileNotFoundError: current=None
 if current and (current.st_dev,current.st_ino)==(s.st_dev,s.st_ino):
  n=s.st_size
  if n==${offset}:
   f.seek(n); f.write(b); f.flush(); os.fsync(f.fileno()); r='OK'
  elif n>=${offset + bytes.byteLength}:
   f.seek(${offset}); r='OK' if f.read(len(b))==b else 'OFFSET'
if r=='OK': os.unlink(q)
print(r)`,
      );

      if (result.trim() !== "OK") throw new SandboxWriteError("SANDBOX_WRITE_OFFSET_MISMATCH");
    } catch (error) {
      // Only failures reach here with a window possibly left behind. It is also
      // removed by discardWrite, or reclaimed once stale after a host interruption.
      try {
        await python(
          runtime,
          ctx,
          sandboxId,
          `import os
try: os.unlink(${JSON.stringify(windowPath)})
except FileNotFoundError: pass`,
        );
      } catch {
        /* The original failure is the useful one. */
      }

      throw error;
    }
  };
}

/**
 * Hash bounded windows before atomic rename; a wrong size/hash can never replace the target.
 * The stage is created 0666 so the sandbox umask decides a new file's mode; an existing
 * regular target keeps its permission bits (the rename would otherwise drop them).
 */
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
   try: t=os.stat(${JSON.stringify(path)},follow_symlinks=False)
   except FileNotFoundError: t=None
   if t and stat.S_ISREG(t.st_mode): os.fchmod(f.fileno(),stat.S_IMODE(t.st_mode)&0o777)
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

/** Sweep stale abandoned stages of one path without touching a live attempt's fresh files. */
export function buildReclaimWrites(runtime: DaytonaContext): SandboxProvider["reclaimWrites"] {
  return async (ctx, sandboxId, directory, prefix, olderThanMs) => {
    if (directory) bounded(directory, LIMITS.pathChars, "PATH");

    bounded(prefix, LIMITS.pathChars, "PATH");
    integer(olderThanMs, HARD_LIMITS.ttl, "WRITE_STALE", 0);

    if (prefix.includes("/")) throw new Error("SANDBOX_INVALID_PATH");

    // Age uses the sandbox's own clock (mtime vs time.time), so host clock skew is
    // irrelevant. Fresh files are skipped before locking; stale ones are rechecked
    // under the same inode lock as append/commit before unlinking.
    await python(
      runtime,
      ctx,
      sandboxId,
      `import os,stat,fcntl,time
d=${JSON.stringify(directory || ".")}
x=${JSON.stringify(prefix)}
left=${LIMITS.writeReclaimBatch}
try: it=os.scandir(d)
except (FileNotFoundError,NotADirectoryError): raise SystemExit
with it:
 for i,e in enumerate(it):
  if i>=${LIMITS.writeReclaimScan} or not left: break
  if not e.name.startswith(x) or not (e.name.endswith('.tmp') or e.name.endswith('.tmp.window')): continue
  try: c=e.stat(follow_symlinks=False)
  except OSError: continue
  if not stat.S_ISREG(c.st_mode) or time.time()-c.st_mtime<=${olderThanMs / 1000}: continue
  try: fd=os.open(e.path,os.O_RDWR|os.O_NOFOLLOW)
  except OSError: continue
  with os.fdopen(fd,'r+b') as f:
   fcntl.flock(f,fcntl.LOCK_EX)
   s=os.fstat(f.fileno())
   try: k=os.stat(e.path,follow_symlinks=False)
   except FileNotFoundError: continue
   if (k.st_dev,k.st_ino)==(s.st_dev,s.st_ino) and time.time()-s.st_mtime>${olderThanMs / 1000}:
    os.unlink(e.path); left-=1`,
    );
  };
}
