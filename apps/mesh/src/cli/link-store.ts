/**
 * External store for the `deco link` task-manager TUI. The daemon pushes
 * cluster/ingress status and SandboxEvents here; the Ink view subscribes via
 * useSyncExternalStore (no useEffect). Mirrors the cli-store pattern.
 */
import type { SandboxEvent } from "../link-daemon/user-desktop-provider";
import type { PendingConfirm } from "./link-confirm";
import type {
  LinkSandboxRecord,
  LinkSandboxStatus,
  SandboxInspection,
} from "./link-sandbox-registry";
import { orderedHandles, selectionAfterRemoval } from "./link-selection";

/**
 * Actions the TUI invokes on the running daemon. Supplied via `setLinkActions`
 * once the daemon has started (the view renders before that, so it stays null
 * until then and key handlers no-op).
 */
export interface LinkActions {
  stopSandbox(handle: string): Promise<void>;
  removeSandbox(
    handle: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  inspectSandbox(handle: string): SandboxInspection | null;
  quit(): Promise<void>;
}

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
  /** Handle of the row the user has selected in the interactive table. */
  selectedHandle: string | null;
  /** Non-null while a delete confirmation is awaiting y/n. */
  pendingConfirm: PendingConfirm | null;
  /** Handles whose removal is in flight (rendered as "Removing…"). */
  removingHandles: Set<string>;
  /** Transient error from the last interactive action (shown in the footer). */
  actionError: string | null;
  /** Daemon actions the TUI invokes; null until the daemon has started. */
  actions: LinkActions | null;
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
    projectName: e.projectName ?? prev?.projectName ?? null,
    branch: e.branch ?? prev?.branch ?? null,
    sandboxPath: e.sandboxPath ?? prev?.sandboxPath ?? null,
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
    selectedHandle: null,
    pendingConfirm: null,
    removingHandles: new Set(),
    actionError: null,
    actions: null,
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

export function setSelectedHandle(handle: string | null) {
  state = { ...state, selectedHandle: handle };
  emit();
}

export function setPendingConfirm(confirm: PendingConfirm | null) {
  state = { ...state, pendingConfirm: confirm };
  emit();
}

export function setActionError(message: string | null) {
  state = { ...state, actionError: message };
  emit();
}

export function setRemoving(handle: string, removing: boolean) {
  if (state.removingHandles.has(handle) === removing) return;
  const removingHandles = new Set(state.removingHandles);
  if (removing) removingHandles.add(handle);
  else removingHandles.delete(handle);
  state = { ...state, removingHandles };
  emit();
}

export function setLinkActions(actions: LinkActions) {
  state = { ...state, actions };
  emit();
}

export function removeSandboxRow(handle: string) {
  const handles = orderedHandles(state.sandboxes);
  const selectedHandle = selectionAfterRemoval(
    handles,
    handle,
    state.selectedHandle,
  );
  const sandboxes = new Map(state.sandboxes);
  sandboxes.delete(handle);
  const removingHandles = new Set(state.removingHandles);
  removingHandles.delete(handle);
  state = {
    ...state,
    sandboxes,
    selectedHandle,
    pendingConfirm: null,
    removingHandles,
  };
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
