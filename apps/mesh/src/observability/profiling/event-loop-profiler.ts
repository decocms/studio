import { Session } from "node:inspector";

/**
 * Off-thread CPU sampling profiler used to NAME what synchronously blocks the
 * event loop. The timer-drift monitor in `event-loop.ts` can only detect a
 * stall *after* it ends (the timer fires late), by which point the blocking
 * code has returned — so a stack captured then is useless. The V8/JSC sampling
 * profiler runs on its own thread, so it keeps sampling the main-thread stack
 * while JS is blocked; the blocking frames are the trailing samples of the
 * profile. (Verified to capture a synchronously-blocked stack under Bun.)
 *
 * Opt-in via EVENT_LOOP_PROFILE=1 — continuous sampling has a cost, so it is
 * off by default and meant to be switched on to catch a known-recurring stall.
 */

type CallFrame = { functionName: string; url: string; lineNumber: number };
type ProfileNode = { id: number; callFrame: CallFrame; children?: number[] };
type CpuProfile = {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
};

let session: Session | null = null;
let available = false;
// Profiler.stop/start are async; guard so a periodic reset and a stall capture
// can't issue overlapping stop/start to the same session.
let busy = false;

function post(
  method: string,
  params?: Record<string, unknown>,
): Promise<{ profile?: CpuProfile }> {
  return new Promise((resolve, reject) =>
    session!.post(method, params, (err, res) =>
      err
        ? reject(err)
        : resolve((res ?? {}) as unknown as { profile?: CpuProfile }),
    ),
  );
}

/** Connect and start continuous sampling. Returns false (gracefully) if the
 *  runtime has no working inspector profiler, so the caller can carry on. */
export async function startStallProfiler(intervalUs: number): Promise<boolean> {
  try {
    session = new Session();
    session.connect();
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: intervalUs });
    await post("Profiler.start");
    available = true;
    return true;
  } catch {
    available = false;
    session = null;
    return false;
  }
}

/** Hottest leaf in the trailing `windowMs` of samples, as a leaf→root stack. */
function hottestStack(profile: CpuProfile, windowMs: number): string[] | null {
  const { nodes, samples, timeDeltas } = profile;
  if (!samples?.length) return null;
  const byId = new Map<number, ProfileNode>();
  const parent = new Map<number, number>();
  for (const n of nodes) {
    byId.set(n.id, n);
    for (const c of n.children ?? []) parent.set(c, n.id);
  }
  // The stall ended ~now and we stop right after, so the blocking samples are
  // the tail. Walk back over `windowMs` of sample time (timeDeltas are µs).
  const windowUs = Math.max(1, windowMs) * 1000;
  let acc = 0;
  const counts = new Map<number, number>();
  for (let i = samples.length - 1; i >= 0; i--) {
    acc += timeDeltas[i] ?? 0;
    const id = samples[i];
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
    if (acc >= windowUs) break;
  }
  let hotId = -1;
  let hotN = 0;
  for (const [id, n] of counts) {
    if (n > hotN) {
      hotN = n;
      hotId = id;
    }
  }
  if (hotId < 0) return null;
  const stack: string[] = [];
  const seen = new Set<number>();
  let cur: number | undefined = hotId;
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    const n = byId.get(cur);
    if (!n) break;
    const f = n.callFrame;
    const where = f.url ? ` ${f.url}:${f.lineNumber + 1}` : "";
    stack.push(`${f.functionName || "(anonymous)"}${where}`);
    cur = parent.get(cur);
  }
  return stack;
}

/** Stop, extract the hot stack from the trailing window, restart with a fresh
 *  buffer for the next stall. Returns null if unavailable/in-flight. */
export async function captureStallStack(
  windowMs: number,
): Promise<string[] | null> {
  if (!available || !session || busy) return null;
  busy = true;
  try {
    const { profile } = await post("Profiler.stop");
    const stack = profile ? hottestStack(profile, windowMs) : null;
    await post("Profiler.start");
    return stack;
  } catch {
    available = false;
    return null;
  } finally {
    busy = false;
  }
}

/** Discard accumulated samples so the buffer doesn't grow unbounded between the
 *  (rare) stalls. Safe to call on a timer — no-op while a capture is in flight. */
export async function resetStallProfiler(): Promise<void> {
  if (!available || !session || busy) return;
  busy = true;
  try {
    await post("Profiler.stop");
    await post("Profiler.start");
  } catch {
    available = false;
  } finally {
    busy = false;
  }
}
