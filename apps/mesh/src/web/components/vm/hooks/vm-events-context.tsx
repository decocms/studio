/**
 * Single SSE connection to mesh's `/api/:org/vm-events`, fanned out via context.
 *
 * Keyed on `(virtualMcpId, branch)` — mesh derives the userId from the
 * authenticated session and composes the same claim handle a racing
 * VM_START would. The stream emits in two phases on one connection:
 *
 *   1. `event: phase` — `ClaimPhase` JSON for the pre-Ready lifecycle.
 *      Surfaces what's happening between VM_START posting a SandboxClaim
 *      and the daemon coming online (capacity wait, image pull, etc).
 *   2. `event: log/status/scripts/processes/reload/branch-status` — passthrough
 *      from the in-pod daemon's `/_decopilot_vm/events`. Same wire format the
 *      browser used to consume directly.
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

import type { UpstreamStatus } from "../upstream-status";
export type { UpstreamStatus };

export interface VmStatus {
  status: UpstreamStatus;
  port: number | null;
  htmlSupport: boolean;
}

export interface BranchStatusReady {
  kind: "ready";
  branch: string;
  base: string;
  workingTreeDirty: boolean;
  unpushed: number;
  aheadOfBase: number;
  behindBase: number;
  /** HEAD sha (falls back to origin/<branch>). Empty if the daemon couldn't compute it. */
  headSha: string;
}

export type BranchStatus =
  | { kind: "initializing" }
  | { kind: "cloning" }
  | { kind: "clone-failed"; error: string }
  | { kind: "checking-out"; to: string }
  | { kind: "checkout-failed"; error: string }
  | BranchStatusReady;

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
  status: VmStatus;
  suspended: boolean;
  /** True after a `gone` event — handle gone, reprovision via VM_START. */
  notFound: boolean;
  scripts: string[];
  activeProcesses: string[];
  intent: { state: "running" | "paused"; reason?: string };
  installing: boolean;
  branchStatus: BranchStatus | null;
  getBuffer: (source: string) => string;
  hasData: (source: string) => boolean;
  subscribeChunks: (handler: ChunkHandler) => () => void;
  /** "reload" SSE fires on config edits framework HMR doesn't watch. */
  subscribeReload: (handler: ReloadHandler) => () => void;
}

const DEFAULT_VALUE: VmEventsValue = {
  phase: null,
  status: { status: "booting", port: null, htmlSupport: false },
  suspended: false,
  notFound: false,
  scripts: [],
  activeProcesses: [],
  intent: { state: "running" },
  installing: false,
  branchStatus: null,
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

const DAEMON_EVENT_TYPES = [
  "log",
  "status",
  "scripts",
  "processes",
  "tasks",
  "intent",
  "phases",
  "reload",
  "branch-status",
] as const;

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
  const [status, setStatus] = useState<VmStatus>({
    status: "booting",
    port: null,
    htmlSupport: false,
  });
  const [suspended, setSuspended] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [scripts, setScripts] = useState<string[]>([]);
  const [activeProcesses, setActiveProcesses] = useState<string[]>([]);
  const [intent, setIntent] = useState<{
    state: "running" | "paused";
    reason?: string;
  }>({ state: "running" });
  const [installing, setInstalling] = useState(false);
  const [branchStatus, setBranchStatus] = useState<BranchStatus | null>(null);
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
    setStatus({ status: "booting", port: null, htmlSupport: false });
    prevPortRef.current = null;
    setSuspended(false);
    setNotFound(false);
    setScripts([]);
    setActiveProcesses([]);
    setIntent({ state: "running" });
    setInstalling(false);
    setBranchStatus(null);
    buffers.current.clear();

    if (!virtualMcpId || !branch) return;

    const sseUrl =
      `/api/${encodeURIComponent(org.slug)}/vm-events?virtualMcpId=${encodeURIComponent(virtualMcpId)}` +
      `&branch=${encodeURIComponent(branch)}`;

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

    const handlePhase = (e: MessageEvent) => {
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
      // about to be stale, so reset:
      //   - phase: residual state would otherwise keep `lifecycleActive`
      //     stuck on "Almost ready" in the booting overlay even though
      //     nothing is starting.
      //   - status / scripts / processes / branchStatus / log buffers: these
      //     describe a sandbox that no longer exists. Resetting to "booting"
      //     ensures the next provisioned sandbox goes through the boot flow.
      // `notFound = true` then drives preview.tsx's self-heal flow when a
      // vmEntry exists; the empty "Start Server" state when it doesn't.
      setNotFound(true);
      setPhase(null);
      setStatus({ status: "booting", port: null, htmlSupport: false });
      setScripts([]);
      setActiveProcesses([]);
      setIntent({ state: "running" });
      setInstalling(false);
      setBranchStatus(null);
      buffers.current.clear();
    };

    const handleDaemonEvent = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);

        if (e.type === "log" && typeof data.data === "string") {
          const source = data.source as string;
          // xterm.js reads bare `\n` as "cursor down, keep column" — normalize.
          const normalized = data.data.replace(/\r?\n/g, "\r\n");
          getOrCreateBuffer(source).append(normalized);
          for (const fn of chunkHandlers.current) {
            try {
              fn(source, normalized);
            } catch {
              // swallow — one broken subscriber shouldn't break others
            }
          }
          setLogTick((t) => t + 1);
        } else if (e.type === "status") {
          const s = data.status;
          const newPort = typeof data.port === "number" ? data.port : null;
          const prevPort = prevPortRef.current;
          prevPortRef.current = newPort;
          setStatus({
            status:
              s === "online" || s === "offline" || s === "booting"
                ? s
                : "booting",
            port: newPort,
            htmlSupport: Boolean(data.htmlSupport),
          });
          // Proxy retargeted to a different active port — the iframe is stuck on
          // whatever page it last loaded. Force-reload so it picks up the new backend.
          if (prevPort !== null && newPort !== null && prevPort !== newPort) {
            for (const fn of reloadHandlers.current) {
              try {
                fn();
              } catch {
                // swallow
              }
            }
          }
        } else if (e.type === "scripts") {
          setScripts(data.scripts ?? []);
        } else if (e.type === "processes") {
          setActiveProcesses(data.active ?? []);
        } else if (e.type === "tasks") {
          // Daemon's task-manager surface; map to the activeProcesses array
          // of script names so the UI's Run/Restart button can render
          // against running script tabs. Match on `logName` — set by
          // /exec/<name> via the spec — instead of regex-parsing `command`,
          // which breaks for any task with trailing args (e.g. `bun run
          // format -- --fix`).
          const active = Array.isArray(data.active)
            ? (data.active as Array<{ logName?: string }>)
                .map((j) => j?.logName ?? "")
                .filter(Boolean)
            : [];
          setActiveProcesses(active);
        } else if (e.type === "intent") {
          const next = data as {
            state?: "running" | "paused";
            reason?: string;
          };
          if (next.state === "running" || next.state === "paused") {
            setIntent({ state: next.state, reason: next.reason });
          }
        } else if (e.type === "phases") {
          const phases =
            (
              data as {
                phases?: Array<{ name: string; status: string }>;
              }
            ).phases ?? [];
          setInstalling(
            phases.some((p) => p.name === "install" && p.status === "running"),
          );
        } else if (e.type === "reload") {
          for (const fn of reloadHandlers.current) {
            try {
              fn();
            } catch {
              // swallow
            }
          }
        } else if (e.type === "branch-status") {
          const kind = String(data.kind ?? "initializing");
          switch (kind) {
            case "ready":
              setBranchStatus({
                kind: "ready",
                branch: String(data.branch ?? ""),
                base: String(data.base ?? "main"),
                workingTreeDirty: Boolean(data.workingTreeDirty),
                unpushed: Number(data.unpushed ?? 0),
                aheadOfBase: Number(data.aheadOfBase ?? 0),
                behindBase: Number(data.behindBase ?? 0),
                headSha: String(data.headSha ?? ""),
              });
              break;
            case "initializing":
              setBranchStatus({ kind: "initializing" });
              break;
            case "cloning":
              setBranchStatus({ kind: "cloning" });
              break;
            case "clone-failed":
              setBranchStatus({
                kind: "clone-failed",
                error: String(data.error ?? ""),
              });
              break;
            case "checkout-failed":
              setBranchStatus({
                kind: "checkout-failed",
                error: String(data.error ?? ""),
              });
              break;
            case "checking-out":
              setBranchStatus({
                kind: "checking-out",
                to: String(data.to ?? ""),
              });
              break;
            default:
              console.warn("[vm-events] unknown branch-status kind:", kind);
              setBranchStatus({ kind: "initializing" });
              break;
          }
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

      es.addEventListener("phase", handlePhase);
      es.addEventListener("gone", handleGone);
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
    status,
    suspended,
    notFound,
    scripts,
    activeProcesses,
    intent,
    installing,
    branchStatus,
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
