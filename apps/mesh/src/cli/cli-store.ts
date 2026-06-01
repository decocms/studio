/**
 * External store for CLI state. The server startup code pushes state updates
 * here, and Ink components subscribe via useSyncExternalStore (no useEffect).
 */
import type { ServiceStatus } from "./header";
import type { LogEntry } from "./log-emitter";

const MAX_LOGS = 500;

interface CliState {
  services: ServiceStatus[];
  migrationsStatus: "pending" | "done";
  serverUrl: string | null;
  logs: LogEntry[];
}

let state: CliState = {
  services: [
    { name: "Postgres", status: "pending", port: 0 },
    { name: "NATS", status: "pending", port: 0 },
  ],
  migrationsStatus: "pending",
  serverUrl: null,
  logs: [],
};

const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function getCliState(): CliState {
  return state;
}

export function subscribeCliState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateService(svc: ServiceStatus) {
  state = {
    ...state,
    services: state.services.map((s) => (s.name === svc.name ? svc : s)),
  };
  emit();
}

export function setMigrationsDone() {
  state = { ...state, migrationsStatus: "done" };
  emit();
}

export function setServerUrl(url: string) {
  state = { ...state, serverUrl: url };
  emit();
}

// Coalesce log inserts so a chatty child can't outpace Ink's reconciler.
// Each addLogEntry pushes into a buffer; the first call in a tick schedules
// a microtask that flushes the buffer with a single state swap + emit. This
// bounds the re-render rate to ~once per microtask boundary regardless of
// how many lines a child pipes in, keeping the TUI hermetic — see comment
// on stripAnsi in cli/commands/dev.ts for the broader hardening story.
let pendingLogs: LogEntry[] = [];
let flushScheduled = false;

function flushPendingLogs() {
  flushScheduled = false;
  if (pendingLogs.length === 0) return;
  const next = state.logs.concat(pendingLogs);
  pendingLogs = [];
  state = {
    ...state,
    logs: next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next,
  };
  emit();
}

export function addLogEntry(entry: LogEntry) {
  pendingLogs.push(entry);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushPendingLogs);
}

export function setDevMode(opts: { localSandboxProvider?: boolean } = {}) {
  state = {
    ...state,
    services: [
      ...state.services,
      // Names MUST match the labels dev.ts passes to updateService(). The
      // store updates services by name; a mismatch silently drops the
      // status transition and the spinner spins forever. The Vite-fronts-
      // Studio topology has the user-facing slot "Web" (vite) and the
      // internal "API" (the mesh API behind the proxy) — keep these two
      // in lockstep with the spawn labels in dev.ts.
      { name: "Web", status: "pending", port: 0 },
      { name: "API", status: "pending", port: 0 },
      // Auto-spawned by `bun run dev --local-sandbox-provider` after the
      // cluster is up — see apps/mesh/src/cli/commands/dev.ts. The
      // desktop sandbox provider routes through this. Marked ready
      // once the link binary's HTTP server begins accepting connections.
      ...(opts.localSandboxProvider
        ? [{ name: "Sandbox", status: "pending" as const, port: 0 }]
        : []),
    ],
  };
  emit();
}

/**
 * When true, console output is being intercepted for TUI rendering.
 * devLogger should skip its own console.log calls to avoid duplicates.
 */
let tuiConsoleIntercepted = false;

export function setTuiConsoleIntercepted(value: boolean) {
  tuiConsoleIntercepted = value;
}

export function isTuiConsoleIntercepted(): boolean {
  return tuiConsoleIntercepted;
}
