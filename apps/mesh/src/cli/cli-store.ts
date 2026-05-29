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
  dataDir: string | null;
}

let state: CliState = {
  services: [
    { name: "Postgres", status: "pending", port: 0 },
    { name: "NATS", status: "pending", port: 0 },
  ],
  migrationsStatus: "pending",
  serverUrl: null,
  logs: [],
  dataDir: null,
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

export function addLogEntry(entry: LogEntry) {
  const logs = [...state.logs, entry];
  state = {
    ...state,
    logs: logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs,
  };
  emit();
}

export function setDevMode(opts: { localSandboxProvider?: boolean } = {}) {
  state = {
    ...state,
    services: [
      ...state.services,
      { name: "Vite", status: "pending", port: 0 },
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

export function setDataDir(dataDir: string) {
  state = { ...state, dataDir };
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
