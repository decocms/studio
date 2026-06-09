/**
 * Single SSE connection to mesh's `/api/:org/sandbox/:virtualMcpId/:branch/events`, fanned out via context.
 *
 * Keyed on `(virtualMcpId, branch)` — mesh derives the userId from the
 * authenticated session and composes the same claim handle a racing
 * SANDBOX_START would. The stream emits in two phases on one connection:
 *
 *   1. `event: phase` — `ClaimPhase` JSON for the pre-Ready lifecycle.
 *      Surfaces what's happening between SANDBOX_START posting a SandboxClaim
 *      and the daemon coming online (capacity wait, image pull, etc).
 *   2. Daemon events (`event: log|lifecycle|status|tasks|scripts|branch|reload`) —
 *      passthrough from the in-pod daemon's `/_sandbox/events`. Types
 *      come from `@decocms/sandbox/shared`.
 *
 *   3. `event: gone` — synthetic. Mesh's upstream daemon fetch returned 404
 *      (sandbox handle missing → operator-evicted on idle TTL). Mapped to
 *      `notFound` which preview.tsx's self-heal flow turns into a SANDBOX_START.
 *
 * `ClaimPhase` is imported as a type-only reference from the canonical
 * server-side definition; `import type` is erased at build time, so the
 * web bundle does not pull in `@kubernetes/client-node` or any of the
 * runner's runtime code.
 */

import {
  createContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useProjectContext } from "@decocms/mesh-sdk";

import type {
  ClaimFailureReason,
  ClaimPhase,
} from "@decocms/sandbox/provider/agent-sandbox";

export type { ClaimFailureReason, ClaimPhase };

import type {
  BranchMeta,
  DaemonEventName,
  DaemonEventPayload,
  DaemonStatus,
  LifecycleState,
} from "@decocms/sandbox/shared";

export type { BranchMeta, DaemonStatus, LifecycleState };

export type ChunkHandler = (source: string, data: string) => void;
export type ReloadHandler = () => void;

export interface SandboxEventsValue {
  /**
   * Latest `ClaimPhase` from the lifecycle portion of the stream. Null until
   * the first phase arrives. Stays at `ready`/`failed` after a terminal
   * phase — callers that want to gate UI on "boot in progress" should pair
   * this with their own signal (e.g. SANDBOX_START in flight, previewUrl
   * present).
   */
  phase: ClaimPhase | null;
  /** Daemon's setup pipeline state. Drives retry UI. */
  lifecycle: LifecycleState;
  /** Daemon's operational state (running / paused / error). */
  status: DaemonStatus;
  /** Git metadata (branch, dirty, divergence). `unknown` until the first compute. */
  branch: BranchMeta;
  /** True after a `gone` event — handle gone, reprovision via SANDBOX_START. */
  notFound: boolean;
  scripts: string[];
  activeProcesses: string[];
  getBuffer: (source: string) => string;
  hasData: (source: string) => boolean;
  subscribeChunks: (handler: ChunkHandler) => () => void;
  /** "reload" SSE fires on config edits framework HMR doesn't watch. */
  subscribeReload: (handler: ReloadHandler) => () => void;
}

const DEFAULT_VALUE: SandboxEventsValue = {
  phase: null,
  lifecycle: { phase: "idle" },
  status: { state: "running" },
  branch: { kind: "unknown" },
  notFound: false,
  scripts: [],
  activeProcesses: [],
  getBuffer: () => "",
  hasData: () => false,
  subscribeChunks: () => () => {},
  subscribeReload: () => () => {},
};

export const SandboxEventsContext =
  createContext<SandboxEventsValue>(DEFAULT_VALUE);

const BUFFER_BYTES = 16384;

class ChunkBuffer {
  private data = "";
  append(chunk: string) {
    this.data += chunk;
    if (this.data.length > BUFFER_BYTES) {
      this.data = this.data.slice(this.data.length - BUFFER_BYTES);
    }
  }
  get() {
    return this.data;
  }
  clear() {
    this.data = "";
  }
}

const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

const DAEMON_EVENT_TYPES: readonly DaemonEventName[] = [
  "lifecycle",
  "status",
  "tasks",
  "scripts",
  "branch",
  "reload",
] as const;
// `log` is broadcast separately — same SSE stream, different shape.
const LOG_EVENT = "log" as const;

export function SandboxEventsProvider({
  virtualMcpId,
  branch,
  enabled = true,
  children,
}: {
  virtualMcpId: string | null;
  branch: string | null;
  /**
   * Open the events stream only when a sandbox exists (or is about to) for
   * this (virtualMcpId, branch). Mounting the provider with `enabled={false}`
   * keeps the idle context available to consumers without connecting — this
   * avoids an endless 404/reconnect loop (and daemon log spam) for branches
   * that never spawn a sandbox, e.g. an ephemeral decopilot run that never
   * touches a VM tool. Defaults to true to preserve prior behavior.
   */
  enabled?: boolean;
  children: ReactNode;
}) {
  const { org } = useProjectContext();
  const [phase, setPhase] = useState<ClaimPhase | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleState>({ phase: "idle" });
  const [status, setStatus] = useState<DaemonStatus>({ state: "running" });
  const [branchMeta, setBranchMeta] = useState<BranchMeta>({ kind: "unknown" });
  const [notFound, setNotFound] = useState(false);
  const [scripts, setScripts] = useState<string[]>([]);
  const [activeProcesses, setActiveProcesses] = useState<string[]>([]);
  // Bumped on log chunks so getBuffer/hasData consumers re-render; buffer
  // mutation alone doesn't.
  const [, setLogTick] = useState(0);

  const buffers = useRef(new Map<string, ChunkBuffer>());
  const chunkHandlers = useRef(new Set<ChunkHandler>());
  const reloadHandlers = useRef(new Set<ReloadHandler>());
  const prevPortRef = useRef<number | null>(null);

  const getOrCreateBuffer = (source: string) => {
    let buf = buffers.current.get(source);
    if (!buf) {
      buf = new ChunkBuffer();
      buffers.current.set(source, buf);
    }
    return buf;
  };

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — SSE subscription lifecycle requires cleanup on unmount; single EventSource with reconnect logic
  useEffect(() => {
    // Reset on key change so stale data doesn't linger across branches.
    setPhase(null);
    setLifecycle({ phase: "idle" });
    setStatus({ state: "running" });
    setBranchMeta({ kind: "unknown" });
    prevPortRef.current = null;
    setNotFound(false);
    setScripts([]);
    setActiveProcesses([]);
    buffers.current.clear();

    if (!virtualMcpId || !branch || !enabled) return;

    const sseUrl = `/api/${encodeURIComponent(org.slug)}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/events`;

    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;

    const handleClaimPhase = (e: MessageEvent) => {
      try {
        const next = JSON.parse(e.data) as ClaimPhase;
        setPhase(next);
        // A fresh non-terminal phase means the lifecycle is making progress
        // again — clear notFound from a prior `gone` so the self-heal UI
        // settles back into the booting overlay, and treat it as a healthy
        // connection so the reconnect backoff resets.
        if (next.kind !== "failed") {
          setNotFound(false);
          reconnectAttempt = 0;
        }
      } catch (err) {
        console.warn("[vm-events] bad phase payload", err);
      }
    };

    const handleGone = () => {
      // The sandbox is gone (idle-evicted, SANDBOX_DELETE'd, or its pod terminated
      // and mesh has stopped finding the handle). Everything we've cached is
      // about to be stale, so reset.
      setNotFound(true);
      setPhase(null);
      setLifecycle({ phase: "idle" });
      setStatus({ state: "running" });
      setBranchMeta({ kind: "unknown" });
      setScripts([]);
      setActiveProcesses([]);
      buffers.current.clear();
    };

    const handleLog = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { source: string; data: string };
        if (typeof data.data !== "string") return;
        // Real daemon output → the sandbox is alive; reset reconnect backoff.
        reconnectAttempt = 0;
        // xterm.js reads bare `\n` as "cursor down, keep column" — normalize.
        const normalized = data.data.replace(/\r?\n/g, "\r\n");
        getOrCreateBuffer(data.source).append(normalized);
        for (const fn of chunkHandlers.current) {
          try {
            fn(data.source, normalized);
          } catch {
            // swallow
          }
        }
        setLogTick((t) => t + 1);
      } catch {
        // ignore parse errors
      }
    };

    const handleDaemonEvent = (e: MessageEvent) => {
      const name = e.type as DaemonEventName;
      try {
        const payload = JSON.parse(e.data);
        // Any daemon event proves the sandbox is reachable; reset backoff.
        reconnectAttempt = 0;
        switch (name) {
          case "lifecycle": {
            const lp = payload as DaemonEventPayload<"lifecycle">;
            setLifecycle(lp.state);
            // Detect dev server port change (running phase carries port);
            // reload iframe so it picks up the new backend.
            const newPort = lp.state.phase === "running" ? lp.state.port : null;
            const prev = prevPortRef.current;
            prevPortRef.current = newPort;
            if (prev !== null && newPort !== null && prev !== newPort) {
              for (const fn of reloadHandlers.current) {
                try {
                  fn();
                } catch {
                  // swallow
                }
              }
            }
            return;
          }
          case "status":
            setStatus(payload as DaemonEventPayload<"status">);
            return;
          case "tasks": {
            const tp = payload as DaemonEventPayload<"tasks">;
            // Map active task `logName`s to the activeProcesses array so the
            // UI's Run/Restart button can render against running script tabs.
            const active = tp.active
              .map((j) => j.logName ?? "")
              .filter(Boolean);
            setActiveProcesses(active);
            return;
          }
          case "scripts":
            setScripts((payload as DaemonEventPayload<"scripts">).scripts);
            return;
          case "branch": {
            const meta = (payload as DaemonEventPayload<"branch">).meta;
            if (import.meta.env.DEV) {
              try {
                if (localStorage.getItem("DEBUG_SAVE_CHANGES") === "1") {
                  console.log("[github-header] branch SSE event", meta);
                }
              } catch {
                // ignore
              }
            }
            setBranchMeta(meta);
            return;
          }
          case "reload":
            for (const fn of reloadHandlers.current) {
              try {
                fn();
              } catch {
                // swallow
              }
            }
            return;
        }
      } catch {
        // ignore parse errors
      }
    };

    function connect() {
      if (disposed) return;

      es = new EventSource(sseUrl);

      // NOTE: deliberately do NOT reset `reconnectAttempt` here. A connection
      // that opens, immediately receives `gone` (handle evicted), and closes
      // still fires `onopen` — resetting on open made that case tight-loop at
      // the 1s floor forever. The backoff is reset only once real daemon
      // data/phase progress arrives (see handleLog/handleDaemonEvent/
      // handleClaimPhase), so repeated `gone`-only reconnects ramp toward the
      // 30s cap instead of hammering.
      es.onopen = () => {};

      es.onerror = () => {
        if (es?.readyState !== EventSource.CLOSED) return;
        scheduleReconnect();
      };

      es.addEventListener("phase", handleClaimPhase);
      es.addEventListener("gone", handleGone);
      es.addEventListener(LOG_EVENT, handleLog);
      for (const type of DAEMON_EVENT_TYPES) {
        es.addEventListener(type, handleDaemonEvent);
      }
    }

    function scheduleReconnect() {
      if (disposed || reconnectTimer) return;

      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempt,
        MAX_RECONNECT_DELAY_MS,
      );
      reconnectAttempt++;

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (disposed) return;
        es?.close();
        connect();
      }, delay);
    }

    connect();

    return () => {
      disposed = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [virtualMcpId, branch, org.slug, enabled]);

  const value: SandboxEventsValue = {
    phase,
    lifecycle,
    status,
    branch: branchMeta,
    notFound,
    scripts,
    activeProcesses,
    getBuffer: (source: string) => buffers.current.get(source)?.get() ?? "",
    hasData: (source: string) =>
      (buffers.current.get(source)?.get().length ?? 0) > 0,
    subscribeChunks: (handler: ChunkHandler) => {
      chunkHandlers.current.add(handler);
      return () => {
        chunkHandlers.current.delete(handler);
      };
    },
    subscribeReload: (handler: ReloadHandler) => {
      reloadHandlers.current.add(handler);
      return () => {
        reloadHandlers.current.delete(handler);
      };
    },
  };

  return <SandboxEventsContext value={value}>{children}</SandboxEventsContext>;
}
