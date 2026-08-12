/**
 * Single SSE connection to studio's `/api/:org/sandbox/:virtualMcpId/:branch/events`, fanned out via context.
 *
 * Keyed on `(virtualMcpId, branch)` — studio derives the userId from the
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
 *   3. `event: gone` — synthetic. Studio's upstream daemon fetch returned 404
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
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveFastPreview } from "@/sdk/fast-preview";
import { KEYS, invalidateVirtualMcpQueries } from "@/lib/query-keys";
import { exponentialBackoffWithJitter } from "@decocms/shared/std";

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
// One definition, shared with the daemon: it decides when to announce a draft
// version, Studio decides when to re-drive the CMS queries. They must agree.
export { isWorkingTreeReadyPhase } from "@decocms/sandbox/shared";
import { isWorkingTreeReadyPhase } from "@decocms/sandbox/shared";

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
  /**
   * Fires the instant a `.deco/*` change is detected — before the debounced
   * reload — so the preview can show its loading overlay immediately instead of
   * waiting out the rebuild debounce.
   */
  subscribeReloadStart: (handler: ReloadHandler) => () => void;
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
  subscribeReloadStart: () => () => {},
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
const DIRECT_EVENTS_PROBE_TIMEOUT_MS = 3_000;

const DAEMON_EVENT_TYPES: readonly DaemonEventName[] = [
  "lifecycle",
  "status",
  "tasks",
  "scripts",
  "branch",
  "reload",
  "file-changed",
] as const;
// `log` is broadcast separately — same SSE stream, different shape.
const LOG_EVENT = "log" as const;

/** True when `queryKey` is a cached live-meta entry for this org/vmid/branch, regardless of its previewUrl suffix. */
export function isLiveMetaKeyForScope(
  queryKey: readonly unknown[],
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
): boolean {
  return (
    queryKey[0] === "live-meta" &&
    queryKey[1] === orgSlug &&
    queryKey[2] === virtualMcpId &&
    queryKey[3] === branch
  );
}

export function buildDirectDaemonEventsUrl(
  previewUrl: string | null | undefined,
): string | null {
  if (!previewUrl) return null;
  try {
    return new URL("/_sandbox/events", previewUrl).href;
  } catch {
    return null;
  }
}

export function isDirectDaemonEventsGoneStatus(status: number): boolean {
  return status === 404;
}

async function probeDirectDaemonEventsGone(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
      signal: AbortSignal.timeout(DIRECT_EVENTS_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    return isDirectDaemonEventsGoneStatus(response.status);
  } catch {
    return false;
  }
}

export function SandboxEventsProvider({
  virtualMcpId,
  branch,
  previewUrl = null,
  enabled = true,
  children,
}: {
  virtualMcpId: string | null;
  branch: string | null;
  previewUrl?: string | null;
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
  const queryClient = useQueryClient();

  // Fast Preview renders via the daemon with NO dev server, so the
  // dev-server-gated `.deco/*` reload path below would never fire. Track it (as
  // a ref, so the SSE closure reads the latest without reconnecting) to still
  // fire a reload on a Blocks save. We deliberately do NOT invalidate the
  // decofile query in that mode — the daemon reads `.deco/blocks/*` straight
  // from disk, and a refetch could revert an optimistic edit against a committed
  // `blocks.gen.json`.
  const vmcp = useVirtualMCP(virtualMcpId ?? undefined);
  const fastPreviewActive = resolveFastPreview(vmcp?.metadata).active;
  const fastPreviewActiveRef = useRef(fastPreviewActive);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- keep the SSE closure reading the latest value without reconnecting
  fastPreviewActiveRef.current = fastPreviewActive;
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
  const reloadStartHandlers = useRef(new Set<ReloadHandler>());
  const prevPortRef = useRef<number | null>(null);
  const directDaemonEventsUrl = buildDirectDaemonEventsUrl(previewUrl);

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
    let liveMetaDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let decofileDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let studioEs: EventSource | null = null;
    let directEs: EventSource | null = null;
    // Tracks the dev-server lifecycle so we can invalidate the CMS queries once
    // it comes up (switching them from the committed `.deco/*.gen.json` snapshot
    // to the live `/.decofile` + `/live/_meta` routes).
    let prevLifecyclePhase: LifecycleState["phase"] | null = null;

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
        if (next.kind === "ready") {
          connectDirectDaemonEvents();
        }
      } catch (err) {
        console.warn("[vm-events] bad phase payload", err);
      }
    };

    const handleGone = () => {
      // The sandbox is gone (idle-evicted, SANDBOX_DELETE'd, or its pod terminated
      // and studio has stopped finding the handle). Everything we've cached is
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
            const cacheKeyForBranch = `${org.slug}/${virtualMcpId}/${branch}`;
            // Working tree just landed (see isWorkingTreeReadyPhase). Re-drive
            // the two things Fast Preview needs but that nothing else retries:
            // the decofile — whose cold-start read 502s while the repo is still
            // cloning and is never retried — and the entity, which carries
            // `previewUrl` in `sandboxMap` behind a 60s staleTime. Without this
            // both stay stale until `running` below, stranding Fast Preview
            // behind the very install it exists to skip.
            if (
              isWorkingTreeReadyPhase(lp.state.phase) &&
              !(
                prevLifecyclePhase &&
                isWorkingTreeReadyPhase(prevLifecyclePhase)
              )
            ) {
              invalidateVirtualMcpQueries(queryClient, org.id);
              // Only when the decofile never loaded (the 502 case) — a
              // populated cache can hold an optimistic block edit a refetch
              // would revert, the same hazard the post-write path guards.
              const decofileKey = KEYS.decofile(cacheKeyForBranch);
              if (queryClient.getQueryData(decofileKey) === undefined) {
                void queryClient.invalidateQueries({ queryKey: decofileKey });
              }
            }
            // Dev server just came up: swap the CMS queries off the committed
            // `.deco/*.gen.json` snapshot and onto the live routes. This is the
            // trigger they rely on (they're enabled as soon as the daemon is up,
            // so the `enabled` flip no longer does it) — see use-decofile /
            // use-live-meta.
            if (
              lp.state.phase === "running" &&
              prevLifecyclePhase !== "running"
            ) {
              // The claim response can resolve before the pod finishes writing
              // `previewUrl` into the entity's `sandboxMap` (60s staleTime on
              // the collection-item query). Without this, `previewUrl` stays
              // null in the sandbox lifecycle context and the CMS/Content
              // panels never mount on a cold-start open — only a hard refresh
              // re-fetches the entity and picks it up.
              invalidateVirtualMcpQueries(queryClient, org.id);
              void queryClient.invalidateQueries({
                queryKey: KEYS.decofile(cacheKeyForBranch),
              });
              void queryClient.invalidateQueries({
                predicate: (query) =>
                  query.queryKey[0] === "live-meta" &&
                  typeof query.queryKey[1] === "string" &&
                  query.queryKey[1].startsWith(`${cacheKeyForBranch}/`),
              });
            }
            prevLifecyclePhase = lp.state.phase;
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
          case "file-changed": {
            const { path: filePath } =
              payload as DaemonEventPayload<"file-changed">;
            const cacheKey = `${org.slug}/${virtualMcpId}/${branch}`;
            // A `.deco/*` change is a config edit the framework's HMR won't pick
            // up. `/.deco/` (not just a leading `.deco/`) also matches projects
            // whose package path isn't the repo root (`<pkg>/.deco/...`), since
            // the daemon reports paths relative to the repo root.
            const isDecoFile =
              filePath.startsWith(".deco/") || filePath.includes("/.deco/");
            if (isDecoFile) {
              // Act when the dev server is running OR Fast Preview is on (which
              // renders via the daemon with no dev server). Otherwise
              // (crashed/paused — committed-snapshot editing) `blocks.gen.json`
              // is a stale build artifact the dev server can't regenerate, so
              // invalidating + refetching it would overwrite the optimistic
              // cache update from useSaveBlock/useDeleteBlock and the edit would
              // visibly revert; leave the optimistic cache as the source of
              // truth until the lifecycle→running transition re-invalidates.
              const devServerRunning = prevLifecyclePhase === "running";
              if (!devServerRunning && !fastPreviewActiveRef.current) return;
              // Turn on the preview's loading overlay immediately — before the
              // debounce below — so the pending refresh feels instant instead of
              // only appearing once the reload finally fires.
              for (const fn of reloadStartHandlers.current) {
                try {
                  fn();
                } catch {
                  // swallow
                }
              }
              // Debounce decofile invalidation for the same reason as liveMeta
              // below: writing a `.deco/` block emits `file-changed`, but the
              // dev server needs a moment to rebuild before `/.decofile`
              // reflects the write. Refetching immediately re-reads the stale
              // pre-rebuild config and clobbers the optimistic cache update from
              // useSaveBlock — so a freshly added page variant briefly appears,
              // then vanishes until a manual reload. Waiting lets the rebuild
              // land first.
              if (decofileDebounceTimer) clearTimeout(decofileDebounceTimer);
              decofileDebounceTimer = setTimeout(() => {
                decofileDebounceTimer = null;
                // Only refetch the decofile when the dev server is running (the
                // live `/.decofile` route reflects the write). In Fast Preview
                // the daemon serves the render straight from disk, so skip the
                // refetch (it would revert an optimistic edit) and just reload.
                if (devServerRunning) {
                  void queryClient.invalidateQueries({
                    queryKey: KEYS.decofile(cacheKey),
                  });
                }
                // Reload the preview iframe once the write has landed — HMR
                // won't reflect a decofile edit, so this is the only thing that
                // refreshes the rendered page after a Blocks save (or an
                // external/agent `.deco/` write). Debounced so it fires after
                // the write lands ("save → refresh").
                for (const fn of reloadHandlers.current) {
                  try {
                    fn();
                  } catch {
                    // swallow
                  }
                }
              }, 500);
            } else {
              // Debounce liveMeta invalidation so the dev server has time to
              // rebuild before we hit /live/_meta. Rapid successive
              // file-changed events reset the timer.
              if (liveMetaDebounceTimer) clearTimeout(liveMetaDebounceTimer);
              liveMetaDebounceTimer = setTimeout(() => {
                liveMetaDebounceTimer = null;
                void queryClient.invalidateQueries({
                  predicate: (query) =>
                    isLiveMetaKeyForScope(
                      query.queryKey,
                      org.slug,
                      virtualMcpId,
                      branch,
                    ),
                });
              }, 1_000);
            }
            return;
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    function connectStudioEvents() {
      if (disposed) return;

      const candidate = new EventSource(sseUrl);
      studioEs = candidate;

      // NOTE: deliberately do NOT reset `reconnectAttempt` here. A connection
      // that opens, immediately receives `gone` (handle evicted), and closes
      // still fires `onopen` — resetting on open made that case tight-loop at
      // the 1s floor forever. The backoff is reset only once real daemon
      // data/phase progress arrives (see handleLog/handleDaemonEvent/
      // handleClaimPhase), so repeated `gone`-only reconnects ramp toward the
      // 30s cap instead of hammering.
      candidate.onopen = () => {};

      candidate.onerror = () => {
        if (studioEs !== candidate) return;
        if (candidate.readyState !== EventSource.CLOSED) return;
        scheduleReconnect("studio");
      };

      candidate.addEventListener("phase", handleClaimPhase);
      candidate.addEventListener("gone", handleGone);
      candidate.addEventListener(LOG_EVENT, handleLog);
      for (const type of DAEMON_EVENT_TYPES) {
        candidate.addEventListener(type, handleDaemonEvent);
      }
    }

    function connectDirectDaemonEvents() {
      if (disposed || !directDaemonEventsUrl || directEs) return;

      const candidate = new EventSource(directDaemonEventsUrl);
      directEs = candidate;
      let opened = false;

      candidate.onopen = () => {
        if (disposed || directEs !== candidate) return;
        opened = true;
        reconnectAttempt = 0;
        const previousStudio = studioEs;
        studioEs = null;
        previousStudio?.close();
      };

      candidate.onerror = () => {
        if (directEs !== candidate) return;
        if (candidate.readyState !== EventSource.CLOSED) return;
        void handleDirectDaemonEventsClosed(candidate, opened);
      };

      candidate.addEventListener(LOG_EVENT, handleLog);
      for (const type of DAEMON_EVENT_TYPES) {
        candidate.addEventListener(type, handleDaemonEvent);
      }
    }

    async function handleDirectDaemonEventsClosed(
      candidate: EventSource,
      opened: boolean,
    ) {
      const gone = directDaemonEventsUrl
        ? await probeDirectDaemonEventsGone(directDaemonEventsUrl)
        : false;
      if (disposed || directEs !== candidate) return;

      candidate.close();
      directEs = null;

      if (gone) {
        handleGone();
        if (!studioEs) connectStudioEvents();
        return;
      }

      if (opened) {
        scheduleReconnect("direct");
      }
      // If direct never opened, leave the Studio stream alive as fallback.
    }

    function scheduleReconnect(target: "studio" | "direct") {
      if (disposed || reconnectTimer) return;

      const delay = exponentialBackoffWithJitter(
        MAX_RECONNECT_DELAY_MS,
        BASE_RECONNECT_DELAY_MS,
        reconnectAttempt,
        2,
        0,
      );
      reconnectAttempt++;

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (disposed) return;
        if (target === "direct") {
          directEs?.close();
          directEs = null;
          connectDirectDaemonEvents();
          return;
        }
        studioEs?.close();
        studioEs = null;
        connectStudioEvents();
      }, delay);
    }

    connectStudioEvents();

    return () => {
      disposed = true;
      studioEs?.close();
      directEs?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (liveMetaDebounceTimer) clearTimeout(liveMetaDebounceTimer);
      if (decofileDebounceTimer) clearTimeout(decofileDebounceTimer);
    };
  }, [
    virtualMcpId,
    branch,
    org.slug,
    enabled,
    directDaemonEventsUrl,
    queryClient,
  ]);

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
    subscribeReloadStart: (handler: ReloadHandler) => {
      reloadStartHandlers.current.add(handler);
      return () => {
        reloadStartHandlers.current.delete(handler);
      };
    },
  };

  return <SandboxEventsContext value={value}>{children}</SandboxEventsContext>;
}
