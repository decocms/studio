/**
 * Single SSE connection to mesh's `/api/:org/vm/:vmId/:branch/events`, fanned out via context.
 *
 * Keyed on `(virtualMcpId, branch)` — mesh derives the userId from the
 * authenticated session and composes the same claim handle a racing
 * VM_START would. The stream emits in two phases on one connection:
 *
 *   1. `event: phase` — `ClaimPhase` JSON for the pre-Ready lifecycle.
 *      Surfaces what's happening between VM_START posting a SandboxClaim
 *      and the daemon coming online (capacity wait, image pull, etc).
 *   2. Daemon events (`event: log|lifecycle|status|tasks|scripts|branch|reload`) —
 *      passthrough from the in-pod daemon's `/_decopilot_vm/events`. Types
 *      come from `@decocms/sandbox/shared`.
 *
 *   3. `event: gone` — synthetic. Mesh's upstream daemon fetch returned 404
 *      (sandbox handle missing → operator-evicted on idle TTL). Mapped to
 *      `notFound` which preview.tsx's self-heal flow turns into a VM_START.
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
} from "@decocms/sandbox/runner/agent-sandbox";

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

export interface VmEventsValue {
  /**
   * Latest `ClaimPhase` from the lifecycle portion of the stream. Null until
   * the first phase arrives. Stays at `ready`/`failed` after a terminal
   * phase — callers that want to gate UI on "boot in progress" should pair
   * this with their own signal (e.g. VM_START in flight, previewUrl
   * present).
   */
  phase: ClaimPhase | null;
  /** Daemon's setup pipeline state. Drives retry UI. */
  lifecycle: LifecycleState;
  /** Daemon's operational state (running / paused / error). */
  status: DaemonStatus;
  /** Git metadata (branch, dirty, divergence). `unknown` until the first compute. */
  branch: BranchMeta;
  suspended: boolean;
  /** True after a `gone` event — handle gone, reprovision via VM_START. */
  notFound: boolean;
  scripts: string[];
  activeProcesses: string[];
  getBuffer: (source: string) => string;
  hasData: (source: string) => boolean;
  subscribeChunks: (handler: ChunkHandler) => () => void;
  /** "reload" SSE fires on config edits framework HMR doesn't watch. */
  subscribeReload: (handler: ReloadHandler) => () => void;
}

const DEFAULT_VALUE: VmEventsValue = {
  phase: null,
  lifecycle: { phase: "idle" },
  status: { state: "running" },
  branch: { kind: "unknown" },
  suspended: false,
  notFound: false,
  scripts: [],
  activeProcesses: [],
  getBuffer: () => "",
  hasData: () => false,
  subscribeChunks: () => () => {},
  subscribeReload: () => () => {},
};

export const VmEventsContext = createContext<VmEventsValue>(DEFAULT_VALUE);

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

// Keyed on connection state (NOT event silence) — a ready dev server has
// nothing to emit. Mesh sends a 15s SSE heartbeat so EventSource.onerror
// fires promptly when mesh or the daemon goes away.
const SUSPENDED_AFTER_ERROR_MS = 60_000;

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

export function VmEventsProvider({
  virtualMcpId,
  branch,
  children,
}: {
  virtualMcpId: string | null;
  branch: string | null;
  children: ReactNode;
}) {
  const { org } = useProjectContext();
  const [phase, setPhase] = useState<ClaimPhase | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleState>({ phase: "idle" });
  const [status, setStatus] = useState<DaemonStatus>({ state: "running" });
  const [branchMeta, setBranchMeta] = useState<BranchMeta>({ kind: "unknown" });
  const [suspended, setSuspended] = useState(false);
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
    setSuspended(false);
    setNotFound(false);
    setScripts([]);
    setActiveProcesses([]);
    buffers.current.clear();

    if (!virtualMcpId || !branch) return;

    const sseUrl = `/api/${encodeURIComponent(org.slug)}/vm/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/events`;

    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let suspendTimer: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;
    /** Latched to true after a `failed` phase — terminal, no reconnect. */
    let terminalFailure = false;

    const enterSuspendTimerIfIdle = () => {
      if (!suspendTimer) {
        suspendTimer = setTimeout(() => {
          setSuspended(true);
        }, SUSPENDED_AFTER_ERROR_MS);
      }
    };

    const clearSuspendTimer = () => {
      if (suspendTimer) {
        clearTimeout(suspendTimer);
        suspendTimer = null;
      }
    };

    const handleClaimPhase = (e: MessageEvent) => {
      try {
        const next = JSON.parse(e.data) as ClaimPhase;
        setPhase(next);
        // A fresh non-terminal phase means the lifecycle is making progress
        // again — clear notFound from a prior `gone` so the self-heal UI
        // settles back into the booting overlay.
        if (next.kind !== "failed") {
          setNotFound(false);
        }
        if (next.kind === "failed") {
          terminalFailure = true;
          es?.close();
        }
      } catch (err) {
        console.warn("[vm-events] bad phase payload", err);
      }
    };

    const handleGone = () => {
      // The sandbox is gone (idle-evicted, VM_DELETE'd, or its pod terminated
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
          case "branch":
            setBranchMeta((payload as DaemonEventPayload<"branch">).meta);
            return;
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
      if (disposed || terminalFailure) return;

      es = new EventSource(sseUrl);

      es.onopen = () => {
        reconnectAttempt = 0;
        clearSuspendTimer();
        setSuspended(false);
      };

      es.onerror = () => {
        if (es?.readyState !== EventSource.CLOSED) return;
        // After a terminal `failed` phase the connection is gone for good
        // and the UI already shows a dedicated error state — surfacing
        // `suspended` on top of that would just stack confusing overlays.
        if (terminalFailure) return;
        // Timer runs only while disconnected; onopen clears it on reconnect.
        enterSuspendTimerIfIdle();
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
      if (disposed || reconnectTimer || terminalFailure) return;

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
      clearSuspendTimer();
    };
  }, [virtualMcpId, branch, org.slug]);

  const value: VmEventsValue = {
    phase,
    lifecycle,
    status,
    branch: branchMeta,
    suspended,
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

  return <VmEventsContext value={value}>{children}</VmEventsContext>;
}
