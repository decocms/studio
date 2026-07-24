import { safeMemoryUsage } from "./safe-memory";

let timer: ReturnType<typeof setInterval> | undefined;

export function startHeapWatch(): () => void {
  if (process.env.HEAP_WATCH !== "1") return () => {};
  const intervalMs = Number(process.env.HEAP_WATCH_INTERVAL_MS ?? 60_000);

  const tick = async () => {
    const m = safeMemoryUsage();
    // memoryUsage() can transiently throw under GC pressure (EINTR). Skip this
    // tick rather than crash — the next one will capture the trend.
    if (!m) return;
    let jsc: {
      objectCount?: number;
      heapSize?: number;
      top?: Record<string, number>;
    } = {};
    try {
      const { heapStats } = await import("bun:jsc");
      const s = heapStats();
      const top = Object.entries(s.objectTypeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);
      jsc = {
        objectCount: s.objectCount,
        heapSize: s.heapSize,
        top: Object.fromEntries(top),
      };
    } catch {
      // not running under Bun — memoryUsage() alone still tracks the trend
    }
    console.log(
      JSON.stringify({
        msg: "heap-watch",
        ts: new Date().toISOString(),
        uptimeS: Math.round(process.uptime()),
        rss: m.rss,
        heapUsed: m.heapUsed,
        heapTotal: m.heapTotal,
        external: m.external,
        arrayBuffers: m.arrayBuffers,
        ...jsc,
      }),
    );
  };

  // Backstop: profiling must never crash the process, so swallow any rejection
  // (e.g. a Bun internal throw from heapStats) instead of leaking it as an
  // unhandled rejection.
  void tick().catch(() => {});
  timer = setInterval(() => void tick().catch(() => {}), intervalMs);
  timer.unref?.();

  process.on("SIGUSR2", () => {
    try {
      const snap = Bun.generateHeapSnapshot("v8");
      const data = typeof snap === "string" ? snap : JSON.stringify(snap);
      const path = `/tmp/heap-${process.pid}-${Date.now()}.heapsnapshot`;
      void Bun.write(path, data);
      console.log(JSON.stringify({ msg: "heap-snapshot-written", path }));
    } catch (err) {
      console.error("[heap-watch] snapshot failed:", err);
    }
  });

  return () => {
    if (timer) clearInterval(timer);
  };
}
