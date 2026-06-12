import * as bunJsc from "bun:jsc";

/**
 * Stall-stack watchdog — names the JS frame that blocks the event loop.
 *
 * Every static guess for the prod loop stalls (JSON.stringify, stream encode,
 * the MCP-server leak's GC, DBOS conductor) has been refuted by measurement.
 * The only way left is to sample the main thread DURING a freeze. `bun:jsc`'s
 * sampling profiler runs on a SEPARATE thread, so it keeps sampling even while
 * the main loop is frozen — the one technique that survives a blocked loop.
 *
 * Mechanism: drain the profiler's sample buffer every tick. While the loop is
 * frozen it can't tick, so the batch drained on the first post-freeze tick IS
 * the set of stacks sampled during the frozen window — no timestamp math. On a
 * tick whose scheduling drift exceeds the threshold, aggregate those stacks by
 * innermost real JS frame and log the hottest ones as `stall-stack`.
 *
 * Gated by STALL_WATCHDOG=1 (off by default — the sampling profiler has a small
 * always-on cost). STALL_WATCHDOG_MS sets the drift threshold (default 100ms,
 * matching the event-loop-stall log threshold so every logged stall gets a
 * stack). Logs flow to stdout → VictoriaLogs, same as event-loop-stall.
 */
interface SampledFrame {
  name?: string;
  sourceURL?: string;
  line?: number;
  category?: string;
}
interface SampledTrace {
  frames: SampledFrame[];
}

// The runtime exports these (verified live on Bun 1.3.11 + 1.3.14) but
// @types/bun omits them from the "bun:jsc" declarations.
const { startSamplingProfiler, samplingProfilerStackTraces } =
  bunJsc as unknown as {
    startSamplingProfiler: () => void;
    samplingProfilerStackTraces: () => { traces?: SampledTrace[] };
  };

export function startStallWatchdog(): () => void {
  if (process.env.STALL_WATCHDOG !== "1") return () => {};

  const stallMs = Number(process.env.STALL_WATCHDOG_MS ?? 100);
  const tickMs = Number(process.env.STALL_WATCHDOG_TICK_MS ?? 50);

  try {
    startSamplingProfiler();
  } catch (err) {
    console.error("[stall-watchdog] failed to start sampling profiler:", err);
    return () => {};
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let expected = performance.now() + tickMs;

  const tick = () => {
    const now = performance.now();
    const drift = now - expected;
    expected = now + tickMs;

    // Drain every tick so the buffer stays bounded and the post-freeze batch is
    // exactly the freeze window's samples.
    let batch: SampledTrace[] = [];
    try {
      batch = samplingProfilerStackTraces()?.traces ?? [];
    } catch {
      // profiler buffer read can race; skip this window
    }

    if (drift > stallMs && batch.length > 0) {
      const counts = new Map<string, number>();
      for (const t of batch) {
        // innermost meaningful JS frame = first with a real sourceURL
        const f =
          t.frames.find(
            (fr) =>
              fr.sourceURL && !/Unknown Executable/.test(fr.category ?? ""),
          ) ?? t.frames[0];
        if (!f) continue;
        const src = (f.sourceURL ?? "?").replace(
          /^.*\/node_modules\//,
          "node_modules/",
        );
        const key = `${f.name ?? "?"} @ ${src}:${f.line ?? "?"}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([frame, count]) => ({ frame, count }));
      console.warn(
        JSON.stringify({
          msg: "stall-stack",
          ts: new Date().toISOString(),
          lagMs: Math.round(drift),
          samplesInWindow: batch.length,
          top,
        }),
      );
    }

    timer = setTimeout(tick, tickMs);
    timer.unref?.();
  };

  timer = setTimeout(tick, tickMs);
  timer.unref?.();

  return () => {
    if (timer) clearTimeout(timer);
  };
}
