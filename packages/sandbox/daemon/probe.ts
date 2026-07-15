/**
 * Single-port HEAD probe. Polls the configured `application.port` at 1 s
 * while booting/offline, 30 s while online. Single-flight HEAD with a 5 s
 * timeout. Treats any HTTP response (incl. 404) as "up".
 */
import {
  PROBE_FAILURE_THRESHOLD,
  PROBE_FAST_MS,
  PROBE_HEAD_TIMEOUT_MS,
  PROBE_SLOW_MS,
} from "./constants";
import { fetchLoopback } from "../proxy/http";

export type UpstreamStatus = "booting" | "online" | "offline";

export interface ProbeState {
  status: UpstreamStatus;
  port: number | null;
  htmlSupport: boolean;
}

export type ProbeEvent =
  | { kind: "head-response"; status: number; isHtml: boolean }
  | { kind: "head-failure" }
  | { kind: "port-change"; port: number | null };

export interface ReduceResult {
  next: ProbeState;
  log?: string;
}

export interface ProbeDeps {
  /** Reads `config.application.port`. Called every tick — config-change-aware. */
  getPort: () => number | null;
  onChange: (state: ProbeState) => void;
  onLog?: (msg: string) => void;
}

export function reduce(state: ProbeState, event: ProbeEvent): ReduceResult {
  switch (event.kind) {
    case "port-change": {
      if (event.port === state.port) return { next: state };
      return {
        next: { status: "booting", port: event.port, htmlSupport: false },
      };
    }
    case "head-response": {
      const next: ProbeState = {
        status: "online",
        port: state.port,
        htmlSupport: event.isHtml,
      };
      if (state.status === "booting") {
        return {
          next,
          log: `[probe] server responded on port ${state.port} (status ${event.status})`,
        };
      }
      if (state.status === "offline") {
        return {
          next,
          log: `[probe] server back online on port ${state.port} (status ${event.status})`,
        };
      }
      return { next };
    }
    case "head-failure": {
      if (state.status !== "online") return { next: state };
      return {
        next: { ...state, status: "offline" },
        log: `[probe] server stopped responding on port ${state.port}`,
      };
    }
  }
}

export function cadence(state: ProbeState): number {
  return state.status === "online" ? PROBE_SLOW_MS : PROBE_FAST_MS;
}

/**
 * Whether a HEAD miss should escalate to a `head-failure` event (→ offline) or
 * be absorbed as a transient blip. Only an *online* server is debounced —
 * `booting`/`offline` pass straight through (reduce ignores head-failure for
 * them anyway). An online server is held until `PROBE_FAILURE_THRESHOLD`
 * consecutive misses so a single slow probe (heavy dev-server work) doesn't
 * report a live server as crashed.
 */
export function shouldEscalateFailure(
  status: UpstreamStatus,
  consecutiveFailures: number,
): boolean {
  return status !== "online" || consecutiveFailures >= PROBE_FAILURE_THRESHOLD;
}

interface HeadResult {
  status: number;
  isHtml: boolean;
}

async function head(
  port: number,
  timeoutMs: number,
): Promise<HeadResult | null> {
  // Explicit AbortController + clearTimeout instead of AbortSignal.timeout().
  // The latter keeps the timer alive past a successful fetch, and a late abort
  // can poison a connection in Bun's keep-alive pool.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchLoopback(port, "/", {
      method: "HEAD",
      signal: ac.signal,
    });
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    return { status: res.status, isHtml: ct.includes("text/html") };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ProbeHandle {
  /**
   * Live `ProbeState` reference — the fields are mutated in place on every
   * change so the SSE handshake (`getLastStatus`) sees fresh values without a
   * getter.
   */
  state: ProbeState;
  /**
   * Run a probe tick right now instead of waiting for the next scheduled one.
   * Called when the port sniffer catches a dev server's bind announcement, so
   * we confirm-and-go-online within a loopback round-trip rather than up to
   * PROBE_FAST_MS later.
   */
  checkNow: () => void;
}

export function startUpstreamProbe(deps: ProbeDeps): ProbeHandle {
  const state: ProbeState = {
    status: "booting",
    port: null,
    htmlSupport: false,
  };
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Consecutive HEAD misses. Reset on any response; drives the debounce so a
  // busy-but-alive dev server isn't flipped to "crashed" on one slow probe.
  let consecutiveFailures = 0;

  function applyEvent(event: ProbeEvent) {
    const result = reduce(state, event);
    const changed =
      result.next.status !== state.status ||
      result.next.port !== state.port ||
      result.next.htmlSupport !== state.htmlSupport;
    state.status = result.next.status;
    state.port = result.next.port;
    state.htmlSupport = result.next.htmlSupport;
    if (result.log) deps.onLog?.(`${result.log}\r\n`);
    if (changed) {
      deps.onChange({
        status: state.status,
        port: state.port,
        htmlSupport: state.htmlSupport,
      });
    }
  }

  async function tick() {
    const port = deps.getPort();
    if (port !== state.port) {
      applyEvent({ kind: "port-change", port });
    }

    if (state.port === null || inFlight) {
      schedule();
      return;
    }

    const portAtStart = state.port;
    inFlight = true;
    let result: HeadResult | null = null;
    try {
      result = await head(portAtStart, PROBE_HEAD_TIMEOUT_MS);
    } finally {
      inFlight = false;
    }

    // Discard if port changed mid-flight; next tick will probe the new port.
    if (state.port !== portAtStart) {
      schedule();
      return;
    }

    if (result !== null) {
      consecutiveFailures = 0;
      applyEvent({
        kind: "head-response",
        status: result.status,
        isHtml: result.isHtml,
      });
    } else {
      consecutiveFailures++;
      // Debounce: hold an online server through transient slow probes; only
      // escalate to offline once we've missed PROBE_FAILURE_THRESHOLD in a row.
      if (shouldEscalateFailure(state.status, consecutiveFailures)) {
        applyEvent({ kind: "head-failure" });
      }
    }
    schedule();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    // While a miss is pending on an online server, re-probe fast so a real
    // crash is confirmed within ~PROBE_FAILURE_THRESHOLD seconds instead of
    // waiting a full slow interval.
    const delay = consecutiveFailures > 0 ? PROBE_FAST_MS : cadence(state);
    timer = setTimeout(() => void tick(), delay);
  }

  schedule();
  return {
    state,
    checkNow: () => {
      if (timer) clearTimeout(timer);
      void tick();
    },
  };
}
