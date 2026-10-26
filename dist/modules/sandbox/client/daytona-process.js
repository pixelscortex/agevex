/**
 * Daytona process adapter operations.
 * The host provider factory binds these to one SDK client and validated settings.
 * Bounds are enforced inside the sandbox before data crosses Convex boundaries.
 */
import {} from "./types.js";
import { python } from "./daytona-context.js";
import { LIMITS, HARD_LIMITS, bounded, integer } from "../shared/limits.js";
/** Bind exec to the provider client; retain its source-side bounds and effect policy. */
export function buildExec(runtime) {
    const operation = {
        async exec(ctx, sandboxId, cmd, { timeoutS, signal }) {
            signal.throwIfAborted();
            bounded(cmd, LIMITS.commandChars, "COMMAND");
            integer(timeoutS, HARD_LIMITS.commandTimeoutS, "COMMAND_TIMEOUT");
            // Provider run truncates the HEAD at 4M chars (process.ts:105). Collect
            // to temporary files inside the sandbox, then transfer bounded tails so
            // arbitrary command output never crosses the component boundary first.
            // The command executes exactly once. The wrapper owns the timeout: it
            // kills the command's whole process group in `finally` (the command runs
            // in its own session, so nothing else would), and reports a timeout as a
            // normal result (exit 124 as coreutils `timeout`, plus the structured
            // `timedOut` flag, since a command may itself exit 124). Daytona's own limit
            // is set LATER than the wrapper's, otherwise it kills the wrapper first
            // and the command survives with an unknown outcome.
            const chars = HARD_LIMITS.outputChars;
            const result = JSON.parse(await python(runtime, ctx, sandboxId, `import subprocess,tempfile,json,os,signal\no=tempfile.TemporaryFile()\ne=tempfile.TemporaryFile()\np=subprocess.Popen(${JSON.stringify(cmd)},shell=True,stdout=o,stderr=e,start_new_session=True)\ndone=False\ntimed=False\ntry:\n p.wait(timeout=${timeoutS})\n done=True\nexcept subprocess.TimeoutExpired:\n timed=True\nfinally:\n if not done:\n  try: os.killpg(p.pid,signal.SIGKILL)\n  except ProcessLookupError: pass\n  p.wait()\ndef tail(f,extra=''):\n f.seek(0,2)\n f.seek(max(0,f.tell()-${chars * LIMITS.utf8BytesPerChar}))\n return (f.read().decode('utf-8',errors='replace')+extra)[-${chars}:]\nprint(json.dumps({'timedOut':timed,'exitCode':124 if timed else p.returncode,'stdout':tail(o),'stderr':tail(e,'\\n[timed out after ${timeoutS}s]' if timed else '')}))`, timeoutS + LIMITS.execKillMarginS));
            signal.throwIfAborted();
            return result;
        },
    };
    return operation.exec;
}
/** Bind startBackground to the provider client; retain its source-side bounds and effect policy. */
export function buildStartBackground(runtime) {
    const operation = {
        async startBackground(ctx, sandboxId, cmd, job) {
            bounded(cmd, LIMITS.commandChars, "COMMAND");
            const jobId = job?.jobId ?? crypto.randomUUID();
            const directory = job?.directory ?? `${LIMITS.backgroundRoot}/${jobId}`;
            bounded(jobId, LIMITS.identityChars, "JOB_ID");
            bounded(directory, LIMITS.pathChars, "JOB_DIRECTORY");
            if (job && job.sandboxId !== sandboxId)
                throw new Error("SANDBOX_JOB_MISMATCH");
            // The provider's disposable VM supplies isolation. Specifically:
            // on completion and on deadline, every process still in the job's original process group is terminated; a process that deliberately detaches (setsid / daemonizes) is outside this guarantee; for full containment stop or delete the sandbox, which `sandbox.stop` / TTL cleanup do.
            // The supervisor stays outside that group. WNOWAIT (or macOS kqueue's
            // NOTE_EXIT) detects exit WITHOUT reaping: the zombie leader reserves its
            // PID/PGID until both signals finish, so neither can hit a reused PGID.
            // macOS local adapter tests use kqueue; there killpg can return EPERM
            // for a zombie-only group. Accept that only after ps confirms no live
            // members. Linux/Daytona permission errors always remain failures.
            // Never call poll()/wait() before cleanup. The marked environment also
            // lets a bounded fallback verify ownership if this supervisor disappears.
            // Same-directory rename publishes each entire identity/result at once;
            // pollers never see a newly opened empty file or a truncated exit code.
            const supervisor = `import os,subprocess,signal,time,select
d=${JSON.stringify(directory)}
def publish(name,value):
 with open(d+'/'+name+'.tmp','w') as f: f.write(str(value)+'\\n')
 os.replace(d+'/'+name+'.tmp',d+'/'+name)
def kill_group(sig):
 try: os.killpg(p.pid,sig)
 except ProcessLookupError: pass
 except PermissionError:
  if hasattr(os,'waitid'): raise
  rows=subprocess.check_output(['ps','-axo','pgid=,stat=']).decode().splitlines()
  if any(int(row.split()[0])==p.pid and not row.split()[1].startswith('Z') for row in rows): raise
publish('supervisor.pid',os.getpid())
with open(d+'/output.log','wb') as log:
 p=subprocess.Popen(${JSON.stringify(cmd)},shell=True,stdout=log,stderr=log,start_new_session=True,env=dict(os.environ,AGEVEX_JOB=${JSON.stringify(jobId)}))
 publish('group.pid',p.pid)
 if not hasattr(os,'waitid'):
  watcher=select.kqueue()
  watcher.control([select.kevent(p.pid,filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT,fflags=select.KQ_NOTE_EXIT)],0,0)
 while not os.path.exists(d+'/cancel.request'):
  exited=os.waitid(os.P_PID,p.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) if hasattr(os,'waitid') else watcher.control([],1,0)
  if exited: break
  time.sleep(${LIMITS.backgroundPublishPollS})
 kill_group(signal.SIGTERM)
 time.sleep(${LIMITS.backgroundKillGraceS})
 kill_group(signal.SIGKILL)
 code=p.wait()
if os.path.exists(d+'/cancel.request'):
 with open(d+'/cancelled','w') as f: f.write('deadline')
publish('status.exit',code)`;
            await python(runtime, ctx, sandboxId, `import os,subprocess,time
d=${JSON.stringify(directory)}
os.makedirs(d,mode=0o700,exist_ok=False)
p=subprocess.Popen(['nohup','python3','-c',${JSON.stringify(supervisor)}],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
while not os.path.exists(d+'/group.pid') and p.poll() is None: time.sleep(${LIMITS.backgroundPublishPollS})
assert os.path.exists(d+'/group.pid'),'background launch failed'`, LIMITS.backgroundExecTimeoutS);
            return { jobId, sandboxId, directory };
        },
    };
    return operation.startBackground;
}
/** Bind poll to the provider client; retain its source-side bounds and effect policy. */
export function buildPoll(runtime) {
    const operation = {
        async poll(ctx, _jobId, { sandboxId, directory }) {
            bounded(directory, LIMITS.pathChars, "JOB_DIRECTORY");
            // tail -c bounds bytes at the source, rather than taking the end of
            // Daytona's truncated prefix. The component receives <=48 KiB of log
            // data (plus JSON escaping), regardless of the on-disk log's size.
            return JSON.parse(await python(runtime, ctx, sandboxId, `import os,json,subprocess
d=${JSON.stringify(directory)}
code=None
if not os.path.isdir(d):
 print(json.dumps({'state':'unknown'}))
 raise SystemExit
try:
 with open(d+'/status.exit') as f: raw=f.read(${LIMITS.identityChars})
 if raw.endswith('\\n'): code=int(raw)
except (FileNotFoundError,ValueError): pass
if os.path.exists(d+'/cancelled'):
 print(json.dumps({'state':'unknown'}))
elif code is None or not os.path.exists(d+'/group.pid'):
 print(json.dumps({'state':'running'}))
else:
 log=subprocess.check_output(['tail','-c',str(${HARD_LIMITS.outputChars * LIMITS.utf8BytesPerChar}),d+'/output.log']).decode('utf-8',errors='replace')[-${HARD_LIMITS.outputChars}:]
 print(json.dumps({'state':'done' if code==0 else 'failed','exitCode':code,'logTail':log}))`, LIMITS.backgroundExecTimeoutS));
        },
    };
    return operation.poll;
}
/** Bind cancelBackground to the provider client; retain its source-side bounds and effect policy. */
export function buildCancelBackground(runtime) {
    const operation = {
        async cancelBackground(ctx, jobId, { sandboxId, directory }) {
            bounded(jobId, LIMITS.identityChars, "JOB_ID");
            bounded(directory, LIMITS.pathChars, "JOB_DIRECTORY");
            // A missing job directory does not mean the command never ran: poll() is
            // only reached after the launch was confirmed, so the command (or a
            // person) removed it while the group may still be alive. Fall back to
            // the environment marker alone; no marked process counts as killed.
            // Request cleanup through the job-owned supervisor, never a bare saved
            // PGID. Unique temporary files + rename make concurrent cancels atomic.
            // If acknowledgement is lost (including a dead supervisor), inspect all
            // current members via /proc before signaling. Missing/unreadable markers
            // mean unknown, not permission to kill. This is conservative ownership
            // verification, not containment against hostile code inside the VM.
            await python(runtime, ctx, sandboxId, `import os,signal,time,tempfile
d=${JSON.stringify(directory)}
if not os.path.isdir(d):
 marker=${JSON.stringify(`AGEVEX_JOB=${jobId}`)}.encode()
 # A marked process can fork a marked child while we kill its parent, so
 # repeat until a whole pass finds none. Bounded: after the last pass anything
 # still marked is reported as not killed (the call fails, the job stays unknown).
 clean=False
 for attempt in range(${LIMITS.markerKillPasses}):
  victims=[]
  with os.scandir('/proc') as entries:
   for entry in entries:
    if not entry.name.isdigit(): continue
    try:
     with open('/proc/'+entry.name+'/environ','rb') as f: env=f.read(${LIMITS.backgroundEnvironmentBytes + 1})
    except (FileNotFoundError,ProcessLookupError,PermissionError): continue
    if len(env)>${LIMITS.backgroundEnvironmentBytes}: raise ValueError('unverified process')
    if marker in env.split(b'\\0'): victims.append(int(entry.name))
  if not victims:
   clean=True
   break
  for pid in victims:
   try: os.kill(pid,signal.SIGKILL)
   except ProcessLookupError: pass
  time.sleep(${LIMITS.markerKillPassPauseS})
 if not clean: raise RuntimeError('marked processes remain')
 raise SystemExit
if not os.path.exists(d+'/status.exit') and not os.path.exists(d+'/cancelled'):
 fd,path=tempfile.mkstemp(dir=d)
 with os.fdopen(fd,'w') as f: f.write('deadline\\n')
 os.replace(path,d+'/cancel.request')
 until=time.monotonic()+${LIMITS.backgroundControlWaitS}
 while not os.path.exists(d+'/status.exit') and not os.path.exists(d+'/cancelled') and time.monotonic()<until:
  time.sleep(${LIMITS.backgroundPublishPollS})
 if not os.path.exists(d+'/status.exit') and not os.path.exists(d+'/cancelled'):
  owned=False
  try:
   with open(d+'/group.pid') as f: pgid=int(f.read(${LIMITS.identityChars}))
   assert pgid>1
   marker=${JSON.stringify(`AGEVEX_JOB=${jobId}`)}.encode()
   with os.scandir('/proc') as entries:
    for entry in entries:
     if not entry.name.isdigit(): continue
     pid=int(entry.name)
     try:
      if os.getpgid(pid)!=pgid: continue
      with open('/proc/'+entry.name+'/environ','rb') as f: env=f.read(${LIMITS.backgroundEnvironmentBytes + 1})
      if len(env)>${LIMITS.backgroundEnvironmentBytes} or marker not in env.split(b'\\0'): raise ValueError('unverified group member')
      if os.getpgid(pid)!=pgid: raise ValueError('group changed')
      owned=True
     except ProcessLookupError: continue
   if owned: os.killpg(pgid,signal.SIGKILL)
  except (OSError,ValueError,AssertionError): owned=False
  with open(d+'/cancelled','w') as f: f.write('deadline' if owned else 'unknown')`, LIMITS.backgroundExecTimeoutS);
        },
    };
    return operation.cancelBackground;
}
