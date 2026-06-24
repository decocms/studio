/**
 * External store for the `deco link` task-manager TUI. The daemon pushes
 * cluster/ingress status and SandboxEvents here; the Ink view subscribes via
 * useSyncExternalStore (no useEffect). Mirrors the cli-store pattern.
 */
import type { SandboxEvent } from "../link-daemon/user-desktop-provider";
import type {
  LinkSandboxRecord,
  LinkSandboxStatus,
} from "./link-sandbox-registry";

// Not exported — internal to this store (mirrors cli-store's CliState).
type ClusterStatus = "connecting" | "linked" | "closed";

export interface SandboxRow {
  handle: string;
  port: number | null;
  previewUrl: string | null;
  status: LinkSandboxStatus;
  error: string | null;
  projectName: string | null;
  branch: string | null;
  sandboxPath: string | null;
}

// Not exported — mirrors cli-store's CliState.
interface LinkState {
  cluster: ClusterStatus;
  /** Studio URL the daemon links against (shown in the TUI header). */
  clusterUrl: string | null;
  ingressUrl: string | null;
  ingressPort: number | null;
  machine: string | null;
  cap: number;
  sandboxes: Map<string, SandboxRow>;
  daemonError: string | null;
  /** Absolute path of the combined `deco link` log file (TUI mode only). */
  logPath: string | null;
}

const DEFAULT_CAP = 20;

function isLiveStatus(status: LinkSandboxStatus): boolean {
  return status === "spawning" || status === "ready" || status === "failed";
}

/**
 * Pure reducer: fold a SandboxEvent into the sandbox map. `evicted`/`deleted`
 * mark known rows stopped so the TUI keeps showing local history; unknown rows
 * remain absent. `failed` retains its error until the next `spawning`.
 */
export function applySandboxEvent(
  sandboxes: Map<string, SandboxRow>,
  e: SandboxEvent,
): Map<string, SandboxRow> {
  const next = new Map(sandboxes);
  const prev = next.get(e.handle);
  if (e.phase === "evicted" || e.phase === "deleted") {
    if (prev) {
      next.set(e.handle, {
        ...prev,
        port: null,
        previewUrl: null,
        status: "stopped",
        error: null,
      });
    }
    return next;
  }
  next.set(e.handle, {
    handle: e.handle,
    port: e.port ?? prev?.port ?? null,
    previewUrl: e.previewUrl ?? prev?.previewUrl ?? null,
    status: e.phase, // "spawning" | "ready" | "failed"
    error: e.phase === "failed" ? (e.error ?? "failed") : null,
    projectName: prev?.projectName ?? null,
    branch: prev?.branch ?? null,
    sandboxPath: prev?.sandboxPath ?? null,
  });
  return next;
}

function initialState(): LinkState {
  return {
    cluster: "connecting",
    clusterUrl: null,
    ingressUrl: null,
    ingressPort: null,
    machine: null,
    cap: DEFAULT_CAP,
    sandboxes: new Map(),
    daemonError: null,
    logPath: null,
  };
}

let state: LinkState = initialState();

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

export function setClusterUrl(url: string) {
  state = { ...state, clusterUrl: url };
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

export function setLogPath(path: string) {
  state = { ...state, logPath: path };
  emit();
}

export function setPersistedSandboxes(rows: LinkSandboxRecord[]) {
  const sandboxes = new Map<string, SandboxRow>();
  for (const row of rows) {
    sandboxes.set(row.handle, {
      handle: row.handle,
      port: row.port,
      previewUrl: row.previewUrl,
      status: row.status,
      error: row.error,
      projectName: row.projectName,
      branch: row.branch,
      sandboxPath: row.sandboxPath,
    });
  }

  for (const [handle, row] of state.sandboxes) {
    if (isLiveStatus(row.status)) {
      sandboxes.set(handle, row);
    }
  }

  state = { ...state, sandboxes };
  emit();
}

export function pushSandboxEvent(event: SandboxEvent) {
  state = {
    ...state,
    sandboxes: applySandboxEvent(state.sandboxes, event),
  };
  emit();
}

export function resetLinkStateForTests() {
  state = initialState();
  listeners.clear();
}
