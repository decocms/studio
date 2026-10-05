import { describe, expect, test } from "bun:test";
import { ContentProtocolError, ErrorCode } from "@decocms/blocks/protocol";
import { DEFAULT_SERVE_ENDPOINT } from "./deco-serve-connection";
import { type DiscoveryState, startDiscovery } from "./deco-serve-discovery";

const OTHER = "http://127.0.0.1:4547/rpc";

/** Timers that run only when the test says, and a tab that can hide. */
function harness() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_: "visibilitychange", fn: () => void) =>
      void listeners.add(fn),
    removeEventListener: (_: "visibilitychange", fn: () => void) =>
      void listeners.delete(fn),
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    doc,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    /** Moves time forward, firing every due timer, and lets probes settle. */
    async advance(ms: number) {
      const until = now + ms;
      await flush();
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = until;
      await flush();
    },
    pendingTimers: () => timers.size,
    async setVisibility(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      for (const listener of listeners) listener();
      await flush();
    },
    listenerCount: () => listeners.size,
  };
}

function run(
  h: ReturnType<typeof harness>,
  candidates: string[],
  probe: (endpoint: string) => Promise<unknown>,
) {
  const found: string[] = [];
  const states: DiscoveryState[] = [];
  const stop = startDiscovery({
    candidates,
    probe,
    onFound: (endpoint) => found.push(endpoint),
    onChange: (state) => states.push(state),
    doc: h.doc,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });
  return { found, states, stop, last: () => states.at(-1)! };
}

const refused = () => Promise.reject(new TypeError("Failed to fetch"));

describe("startDiscovery", () => {
  test("connects as soon as the default port answers", async () => {
    const h = harness();
    let up = false;
    const probed: string[] = [];
    const d = run(h, [DEFAULT_SERVE_ENDPOINT], (endpoint) => {
      probed.push(endpoint);
      return up ? Promise.resolve({}) : refused();
    });
    await h.advance(0);
    expect(d.found).toEqual([]);
    expect(d.last()).toMatchObject({
      status: "searching",
      firstRoundDone: true,
      problem: null,
    });

    up = true;
    await h.advance(1_000);
    expect(d.found).toEqual([DEFAULT_SERVE_ENDPOINT]);
    expect(d.last().status).toBe("found");
    // Nothing left running.
    expect(h.pendingTimers()).toBe(0);
    expect(h.listenerCount()).toBe(0);
    d.stop();
  });

  test("probes the remembered server first, one at a time", async () => {
    const h = harness();
    const probed: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const d = run(h, [OTHER, DEFAULT_SERVE_ENDPOINT], async (endpoint) => {
      probed.push(endpoint);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      if (endpoint === DEFAULT_SERVE_ENDPOINT) return {};
      throw new TypeError("Failed to fetch");
    });
    await h.advance(0);
    expect(probed).toEqual([OTHER, DEFAULT_SERVE_ENDPOINT]);
    expect(maxInFlight).toBe(1);
    expect(d.found).toEqual([DEFAULT_SERVE_ENDPOINT]);
  });

  test("backs off up to 15s between rounds", async () => {
    const h = harness();
    let probes = 0;
    const d = run(h, [DEFAULT_SERVE_ENDPOINT], () => {
      probes += 1;
      return refused();
    });
    await h.advance(0);
    expect(probes).toBe(1);
    // 1s, 2s, 4s, 8s, then 15s each.
    await h.advance(1_000);
    expect(probes).toBe(2);
    await h.advance(2_000);
    expect(probes).toBe(3);
    await h.advance(4_000 + 8_000);
    expect(probes).toBe(5);
    await h.advance(14_999);
    expect(probes).toBe(5);
    await h.advance(1);
    expect(probes).toBe(6);
    d.stop();
  });

  test("stops polling while the tab is hidden and resumes when it shows", async () => {
    const h = harness();
    let probes = 0;
    const d = run(h, [DEFAULT_SERVE_ENDPOINT], () => {
      probes += 1;
      return refused();
    });
    await h.advance(0);
    expect(probes).toBe(1);

    await h.setVisibility("hidden");
    expect(d.last().status).toBe("paused");
    expect(h.pendingTimers()).toBe(0);
    await h.advance(60_000);
    expect(probes).toBe(1);

    await h.setVisibility("visible");
    expect(probes).toBe(2);
    expect(d.last().status).toBe("searching");
    d.stop();
  });

  test("does not start probing in a hidden tab", async () => {
    const h = harness();
    h.doc.visibilityState = "hidden";
    let probes = 0;
    const d = run(h, [DEFAULT_SERVE_ENDPOINT], () => {
      probes += 1;
      return refused();
    });
    await h.advance(30_000);
    expect(probes).toBe(0);
    expect(d.last().status).toBe("paused");
    d.stop();
  });

  test("reports a server that answers but can't be used, and keeps looking", async () => {
    const h = harness();
    let probes = 0;
    const d = run(h, [DEFAULT_SERVE_ENDPOINT], () => {
      probes += 1;
      return Promise.reject(
        new ContentProtocolError(
          ErrorCode.Unauthorized,
          "missing or invalid bearer token",
        ),
      );
    });
    await h.advance(0);
    expect(d.last().problem).toEqual({
      reason: "outdated",
      endpoint: DEFAULT_SERVE_ENDPOINT,
    });
    expect(d.found).toEqual([]);
    await h.advance(1_000);
    expect(probes).toBe(2);
    d.stop();
  });

  test("stop() ends the search", async () => {
    const h = harness();
    let probes = 0;
    const d = run(h, [DEFAULT_SERVE_ENDPOINT], () => {
      probes += 1;
      return refused();
    });
    await h.advance(0);
    d.stop();
    await h.advance(60_000);
    expect(probes).toBe(1);
    expect(h.listenerCount()).toBe(0);
  });

  test("with no candidate (all disconnected), probes nothing", async () => {
    const h = harness();
    let probes = 0;
    const d = run(h, [], () => {
      probes += 1;
      return refused();
    });
    await h.advance(30_000);
    expect(probes).toBe(0);
    expect(d.last().status).toBe("stopped");
    d.stop();
  });
});
