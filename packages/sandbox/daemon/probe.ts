/**
 * Single-port HEAD probe. Polls the configured `application.port` at 1 s
 * while booting/offline, 30 s while online. Single-flight HEAD with a 5 s
 * timeout. Treats any HTTP response (incl. 404) as "up".
 */
import {
  PROBE_FAST_MS,
  PROBE_HEAD_TIMEOUT_MS,
  PROBE_SLOW_MS,
} from "./constants";
import { fetchLoopback } from "./upstream-fetch";

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

interface HeadResult {
  status: number;
  isHtml: boolean;
}

async function head(
  port: number,
  timeoutMs: number,
): Promise<HeadResult | null> {
  try {
    const res = await fetchLoopback(port, "/", {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    return { status: res.status, isHtml: ct.includes("text/html") };
  } catch {
    return null;
  }
}

/**
 * Returns a live `ProbeState` reference — the fields are mutated in place
 * on every change so the SSE handshake (`getLastStatus`) sees fresh values
 * without a getter.
 */
export function startUpstreamProbe(deps: ProbeDeps): ProbeState {
  const state: ProbeState = {
    status: "booting",
    port: null,
    htmlSupport: false,
  };
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

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
      applyEvent({
        kind: "head-response",
        status: result.status,
        isHtml: result.isHtml,
      });
    } else {
      applyEvent({ kind: "head-failure" });
    }
    schedule();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), cadence(state));
  }

  schedule();
  return state;
}
