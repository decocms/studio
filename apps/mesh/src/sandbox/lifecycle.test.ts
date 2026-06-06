import { beforeEach, describe, expect, it } from "bun:test";
import type { ClaimPhase, SandboxProvider } from "@decocms/sandbox/provider";
import {
  __resetSharedLifecyclesForTesting,
  selectDesktopTransport,
  subscribeLifecycle,
} from "./lifecycle";

// ---------------------------------------------------------------------------
// subscribeLifecycle — multi-tab dedup
// ---------------------------------------------------------------------------

interface FakeWatchableHandle {
  runner: SandboxProvider;
  /** How many times the source generator has been started. */
  starts: () => number;
  /** Push a phase to the active source generator. */
  emit: (phase: ClaimPhase) => Promise<void>;
  /** Resolve when all listeners attached to the source unsubscribe. */
  endedSignal: () => AbortSignal;
}

/**
 * Synthesize a `SandboxProvider` whose `watchClaimLifecycle` is an async
 * generator we can drive frame-by-frame from the test. The other interface
 * methods are no-ops; only the watcher is exercised here. Tracks how many
 * times the generator has been instantiated (so we can prove dedup).
 */
function makeFakeWatchable(): FakeWatchableHandle {
  let starts = 0;
  let pushNext: ((phase: ClaimPhase | null) => void) | null = null;
  let endedAbort = new AbortController();

  async function* gen(
    _claim: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    starts += 1;
    endedAbort = new AbortController();
    while (true) {
      const phase = await new Promise<ClaimPhase | null>((resolve) => {
        pushNext = resolve;
        if (signal?.aborted) resolve(null);
        signal?.addEventListener("abort", () => resolve(null), { once: true });
      });
      if (phase === null) {
        endedAbort.abort();
        return;
      }
      yield phase;
      if (phase.kind === "ready" || phase.kind === "failed") {
        endedAbort.abort();
        return;
      }
    }
  }

  const runner: SandboxProvider = {
    kind: "cluster",
    ensure: async () => ({ handle: "h", workdir: "/app", previewUrl: null }),
    delete: async () => {},
    alive: async () => true,
    getPreviewUrl: async () => null,
    proxyDaemonRequest: async () => new Response(null, { status: 204 }),
    watchClaimLifecycle: gen,
  };

  return {
    runner,
    starts: () => starts,
    emit: async (phase: ClaimPhase) => {
      pushNext?.(phase);
      // let the generator's microtask drain (yield then emit to listeners)
      await Promise.resolve();
      await Promise.resolve();
    },
    endedSignal: () => endedAbort.signal,
  };
}

describe("subscribeLifecycle", () => {
  beforeEach(() => {
    __resetSharedLifecyclesForTesting();
  });

  it("fans out one source to multiple listeners", async () => {
    const fake = makeFakeWatchable();
    const seenA: ClaimPhase[] = [];
    const seenB: ClaimPhase[] = [];

    const a = subscribeLifecycle(fake.runner, "claim-x", (p) => seenA.push(p));
    const b = subscribeLifecycle(fake.runner, "claim-x", (p) => seenB.push(p));

    expect(fake.starts()).toBe(1); // dedup: one source for two listeners

    await fake.emit({ kind: "claiming", since: 1 });
    await fake.emit({ kind: "pulling-image", since: 1 });

    expect(seenA.map((p) => p.kind)).toEqual(["claiming", "pulling-image"]);
    expect(seenB.map((p) => p.kind)).toEqual(["claiming", "pulling-image"]);

    a.unsubscribe();
    b.unsubscribe();
  });

  it("replays the most recent phase to a late joiner", async () => {
    const fake = makeFakeWatchable();
    const seenA: ClaimPhase[] = [];
    const a = subscribeLifecycle(fake.runner, "claim-y", (p) => seenA.push(p));
    await fake.emit({ kind: "claiming", since: 1 });
    await fake.emit({ kind: "pulling-image", since: 1 });

    const seenB: ClaimPhase[] = [];
    const b = subscribeLifecycle(fake.runner, "claim-y", (p) => seenB.push(p));

    // Late joiner immediately gets the cached `pulling-image`.
    expect(seenB.map((p) => p.kind)).toEqual(["pulling-image"]);
    expect(fake.starts()).toBe(1); // still one source

    a.unsubscribe();
    b.unsubscribe();
  });

  it("aborts the source when the last listener unsubscribes", async () => {
    const fake = makeFakeWatchable();
    const a = subscribeLifecycle(fake.runner, "claim-z", () => {});
    await fake.emit({ kind: "claiming", since: 1 });
    expect(fake.endedSignal().aborted).toBe(false);

    a.unsubscribe();
    // Drain microtasks so the generator's abort listener runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.endedSignal().aborted).toBe(true);
  });

  it("rebuilds the source after a terminal phase clears the entry", async () => {
    const fake = makeFakeWatchable();
    const a = subscribeLifecycle(fake.runner, "claim-t", () => {});
    await fake.emit({ kind: "ready" });
    expect(fake.starts()).toBe(1);

    // Ready already terminated and the cache entry was deleted in the
    // generator's finally — the next subscribe must spin up a fresh source.
    // Drain microtasks to let the generator's finally run.
    await Promise.resolve();
    await Promise.resolve();
    const b = subscribeLifecycle(fake.runner, "claim-t", () => {});
    expect(fake.starts()).toBe(2);

    a.unsubscribe();
    b.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// selectDesktopTransport — Phase C-bis S3 provider transport flag
// ---------------------------------------------------------------------------

describe("selectDesktopTransport", () => {
  it("selects pull only for the exact 'pull' value", () => {
    expect(selectDesktopTransport("pull")).toBe("pull");
  });

  it("defaults to ws when unset", () => {
    expect(selectDesktopTransport(undefined)).toBe("ws");
  });

  it("defaults to ws for empty / other values (flag OFF by default)", () => {
    expect(selectDesktopTransport("")).toBe("ws");
    expect(selectDesktopTransport("ws")).toBe("ws");
    expect(selectDesktopTransport("PULL")).toBe("ws");
    expect(selectDesktopTransport("true")).toBe("ws");
  });
});
