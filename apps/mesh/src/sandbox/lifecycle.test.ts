import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DockerSandboxRunner,
  type ClaimPhase,
  type SandboxRunner,
} from "@decocms/sandbox/runner";
import type { MeshContext } from "@/core/mesh-context";
import {
  __resetSharedLifecyclesForTesting,
  asDockerRunner,
  getRunnerByKind,
  subscribeLifecycle,
} from "./lifecycle";

// Minimal MeshContext stub — lifecycle only reads ctx.db, and only to hand
// it to the KyselySandboxRunnerStateStore constructor (no queries run until
// an actual ensure/delete call).
const stubCtx = { db: {} } as unknown as MeshContext;

describe("asDockerRunner", () => {
  it("returns null for null input", () => {
    expect(asDockerRunner(null)).toBeNull();
  });

  it("returns the instance unchanged for a DockerSandboxRunner", () => {
    const runner = new DockerSandboxRunner();
    expect(asDockerRunner(runner)).toBe(runner);
  });

  it("returns null for a non-Docker runner", () => {
    // Duck-typed non-Docker runner — satisfies the SandboxRunner shape but
    // isn't a DockerSandboxRunner instance, so instanceof narrows to null.
    const fake = {
      kind: "freestyle" as const,
      ensure: async () => ({ handle: "h", workdir: "/app", previewUrl: null }),
      exec: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      delete: async () => {},
      alive: async () => false,
      getPreviewUrl: async () => null,
      proxyDaemonRequest: async () => new Response(null, { status: 204 }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: intentional duck-type
    expect(asDockerRunner(fake as any)).toBeNull();
  });
});

describe("getRunnerByKind caching", () => {
  // The `runners` cache lives at module scope, so a kind cached by one test
  // leaks into later tests. Isolate by claiming a kind once per suite and
  // asserting identity within the same test only.

  beforeEach(() => {
    // No-op: we can't reset module state without dynamic re-import, so each
    // test must use independent observations (see below).
  });

  afterEach(() => {});

  it("returns the same DockerSandboxRunner instance across calls", async () => {
    const a = await getRunnerByKind(stubCtx, "docker");
    const b = await getRunnerByKind(stubCtx, "docker");
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(DockerSandboxRunner);
  });
});

// ---------------------------------------------------------------------------
// subscribeLifecycle — multi-tab dedup
// ---------------------------------------------------------------------------

interface FakeWatchableHandle {
  runner: SandboxRunner;
  /** How many times the source generator has been started. */
  starts: () => number;
  /** Push a phase to the active source generator. */
  emit: (phase: ClaimPhase) => Promise<void>;
  /** Resolve when all listeners attached to the source unsubscribe. */
  endedSignal: () => AbortSignal;
}

/**
 * Synthesize a `SandboxRunner` whose `watchClaimLifecycle` is an async
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

  const runner: SandboxRunner = {
    kind: "agent-sandbox",
    ensure: async () => ({ handle: "h", workdir: "/app", previewUrl: null }),
    exec: async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }),
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
