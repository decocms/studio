/**
 * `/site-editor`'s search for a running `deco serve`: probes the candidate
 * endpoints (the last one used, then the default port) one at a time, backing
 * off from 1s to 15s while none answers, and pausing while the tab is hidden.
 * One request at most is in flight, each with a timeout, so it never blocks
 * the page or floods the console.
 *
 * Plain logic with its timers, document and probe injected, so it is tested
 * without React or a network.
 */

import {
  classifyServeProbeError,
  probeRetryDelay,
  type ServeProblem,
} from "./deco-serve-connection";

/** Retries back off up to this, so a closed port is rarely re-asked. */
export const DISCOVERY_MAX_DELAY_MS = 15_000;
/** A probe that takes longer than this counts as no answer. */
export const DISCOVERY_PROBE_TIMEOUT_MS = 3_000;

export interface DiscoveryState {
  /** `paused`: the tab is hidden; nothing is probed until it shows again. */
  status: "searching" | "paused" | "found" | "stopped";
  /** Whether every candidate was probed at least once. */
  firstRoundDone: boolean;
  /** A candidate that answered, but can't be used (out of date, …). */
  problem: (ServeProblem & { endpoint: string }) | null;
}

interface VisibilityTarget {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface DiscoveryOptions {
  candidates: readonly string[];
  /** Resolves when `endpoint` is a usable `deco serve`; throws otherwise. */
  probe: (endpoint: string, signal: AbortSignal) => Promise<unknown>;
  onFound: (endpoint: string) => void;
  onChange: (state: DiscoveryState) => void;
  doc?: VisibilityTarget;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  timeoutMs?: number;
}

/** Starts the search; the returned function stops it. */
export function startDiscovery(options: DiscoveryOptions): () => void {
  const {
    candidates,
    probe,
    onFound,
    onChange,
    doc = document,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle as number),
    timeoutMs = DISCOVERY_PROBE_TIMEOUT_MS,
  } = options;

  let state: DiscoveryState = {
    status: "searching",
    firstRoundDone: false,
    problem: null,
  };
  let stopped = false;
  let running = false;
  let failures = 0;
  let timer: unknown = null;
  let controller: AbortController | null = null;

  const hidden = () => doc.visibilityState === "hidden";

  const update = (patch: Partial<DiscoveryState>) => {
    state = { ...state, ...patch };
    onChange(state);
  };

  const probeOnce = async (endpoint: string): Promise<boolean> => {
    controller = new AbortController();
    const abort = controller;
    const timeout = setTimer(() => abort.abort(), timeoutMs);
    try {
      await probe(endpoint, abort.signal);
      return true;
    } catch (error) {
      if (stopped) return false;
      const problem = classifyServeProbeError(error);
      if (problem.reason !== "not-answering") {
        update({ problem: { ...problem, endpoint } });
      } else if (state.problem?.endpoint === endpoint) {
        update({ problem: null });
      }
      return false;
    } finally {
      clearTimer(timeout);
      controller = null;
    }
  };

  const round = async () => {
    timer = null;
    if (stopped || running) return;
    if (candidates.length === 0) {
      update({ status: "stopped", firstRoundDone: true });
      return;
    }
    if (hidden()) {
      update({ status: "paused" });
      return;
    }
    running = true;
    if (state.status !== "searching") update({ status: "searching" });
    for (const endpoint of candidates) {
      if (stopped) break;
      if (await probeOnce(endpoint)) {
        running = false;
        if (stopped) return;
        stopped = true;
        doc.removeEventListener("visibilitychange", onVisibility);
        update({ status: "found", firstRoundDone: true });
        onFound(endpoint);
        return;
      }
    }
    running = false;
    if (stopped) return;
    failures += 1;
    if (!state.firstRoundDone) update({ firstRoundDone: true });
    if (hidden()) {
      update({ status: "paused" });
      return;
    }
    timer = setTimer(
      () => void round(),
      probeRetryDelay(failures, DISCOVERY_MAX_DELAY_MS),
    );
  };

  function onVisibility() {
    if (stopped) return;
    if (hidden()) {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (!running) update({ status: "paused" });
      return;
    }
    // Back in view: look again at once, from the shortest delay.
    if (timer !== null) clearTimer(timer);
    failures = 0;
    void round();
  }

  doc.addEventListener("visibilitychange", onVisibility);
  onChange(state);
  void round();

  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    controller?.abort();
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
