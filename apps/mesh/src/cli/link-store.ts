/**
 * External store for the `deco link` task-manager TUI. The daemon pushes
 * cluster/ingress status and SandboxEvents here; the Ink view subscribes via
 * useSyncExternalStore (no useEffect). Mirrors the cli-store pattern.
 */
import type { SandboxEvent } from "../link-daemon/user-desktop-provider";

// Not exported — internal to this store (mirrors cli-store's CliState).
type ClusterStatus = "connecting" | "linked" | "closed";

export interface SandboxRow {
  handle: string;
  port: number | null;
  previewUrl: string | null;
  status: "spawning" | "ready" | "failed";
  error: string | null;
  activeDispatchCount: number;
  /** Wall-clock ms of the last event for this handle; drives the IDLE column. */
  lastChangeAt: number;
}

// Not exported — mirrors cli-store's CliState.
interface LinkState {
  cluster: ClusterStatus;
  ingressUrl: string | null;
  ingressPort: number | null;
  machine: string | null;
  cap: number;
  sandboxes: Map<string, SandboxRow>;
  daemonError: string | null;
}

const DEFAULT_CAP = 20;

/**
 * Pure reducer: fold a SandboxEvent into the sandbox map. `evicted`/`deleted`
 * drop the row; `failed` retains it with its error until the next `spawning`.
 */
export function applySandboxEvent(
  sandboxes: Map<string, SandboxRow>,
  e: SandboxEvent,
  now: number,
): Map<string, SandboxRow> {
  const next = new Map(sandboxes);
  if (e.phase === "evicted" || e.phase === "deleted") {
    next.delete(e.handle);
    return next;
  }
  const prev = next.get(e.handle);
  next.set(e.handle, {
    handle: e.handle,
    port: e.port ?? prev?.port ?? null,
    previewUrl: e.previewUrl ?? prev?.previewUrl ?? null,
    status: e.phase, // "spawning" | "ready" | "failed"
    error: e.phase === "failed" ? (e.error ?? "failed") : null,
    activeDispatchCount:
      e.activeDispatchCount ?? prev?.activeDispatchCount ?? 0,
    lastChangeAt: now,
  });
  return next;
}

/** Relative idle duration, coarse (`0s`/`5s`/`1m`/`1h`). */
export function formatIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

let state: LinkState = {
  cluster: "connecting",
  ingressUrl: null,
  ingressPort: null,
  machine: null,
  cap: DEFAULT_CAP,
  sandboxes: new Map(),
  daemonError: null,
};

const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function getLinkState(): LinkState {
  return state;
}

export function subscribeLinkState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setCluster(status: ClusterStatus) {
  state = { ...state, cluster: status };
  emit();
}

export function setIngress(port: number, url: string) {
  state = { ...state, ingressPort: port, ingressUrl: url };
  emit();
}

export function setMachine(label: string) {
  state = { ...state, machine: label };
  emit();
}

export function setDaemonError(message: string) {
  state = { ...state, daemonError: message };
  emit();
}

export function pushSandboxEvent(event: SandboxEvent) {
  state = {
    ...state,
    sandboxes: applySandboxEvent(state.sandboxes, event, Date.now()),
  };
  emit();
}
