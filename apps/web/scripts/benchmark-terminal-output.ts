import { TerminalOutputScheduler } from "../src/desktop/agent-terminal/terminal-output-scheduler";

const PAYLOAD_BYTES = 4 * 1024 * 1024;
const FRAME_BYTES = 4 * 1024;
const ITERATIONS = 5;

interface BenchmarkResult {
  mode: "legacy" | "v2";
  medianMs: number;
  throughputMiBPerSecond: number;
  writes: number;
  peakQueuedMiB: number;
}

async function measure(
  mode: BenchmarkResult["mode"],
): Promise<BenchmarkResult> {
  const samples: number[] = [];
  let finalWrites = 0;
  let finalPeakBytes = 0;

  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    let resolveParsed: (() => void) | undefined;
    const parsed = new Promise<void>((resolve) => {
      resolveParsed = resolve;
    });
    let acknowledgements = 0;
    const scheduler = new TerminalOutputScheduler({
      write: (_data, onParsed) => queueMicrotask(onParsed),
      onFrameStart: () => {},
      onFrameParsed: () => {
        acknowledgements++;
        if (acknowledgements === PAYLOAD_BYTES / FRAME_BYTES) resolveParsed?.();
      },
      onOverflow: () => {
        throw new Error("benchmark exceeded the bounded renderer queue");
      },
      ...(mode === "legacy"
        ? {
            chunkBytes: 256 * 1024,
            maxQueuedBytes: Number.MAX_SAFE_INTEGER,
            coalesce: false,
            schedule: (callback: () => void) => callback(),
          }
        : {}),
    });

    const data = new Uint8Array(FRAME_BYTES);
    const startedAt = performance.now();
    for (
      let offset = FRAME_BYTES;
      offset <= PAYLOAD_BYTES;
      offset += FRAME_BYTES
    ) {
      scheduler.enqueue(
        {
          kind: "output",
          seq: offset,
          data,
          allowCapabilityReplies: false,
          restorePendingCapabilityReplies: false,
          restoreUntilSeq: null,
        },
        () => {},
      );
    }
    await parsed;
    samples.push(performance.now() - startedAt);
    const snapshot = scheduler.snapshot();
    finalWrites = snapshot.writeCount;
    finalPeakBytes = snapshot.peakQueuedBytes;
    scheduler.dispose();
  }

  samples.sort((left, right) => left - right);
  const medianMs = samples[Math.floor(samples.length / 2)] ?? 0;
  return {
    mode,
    medianMs: Number(medianMs.toFixed(2)),
    throughputMiBPerSecond: Number(
      (PAYLOAD_BYTES / 1024 / 1024 / (medianMs / 1000)).toFixed(2),
    ),
    writes: finalWrites,
    peakQueuedMiB: Number((finalPeakBytes / 1024 / 1024).toFixed(2)),
  };
}

const results = [await measure("legacy"), await measure("v2")];
console.log(
  JSON.stringify(
    {
      payloadMiB: PAYLOAD_BYTES / 1024 / 1024,
      frameKiB: FRAME_BYTES / 1024,
      iterations: ITERATIONS,
      note: "Synthetic scheduler baseline; native E2E covers the WebSocket credit window.",
      results,
    },
    null,
    2,
  ),
);
