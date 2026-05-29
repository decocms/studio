/**
 * Server startup logic extracted from cli.ts.
 *
 * Delegates environment resolution, service startup, and migrations to
 * buildSettings(). Reports progress via the CLI store so the Ink UI can
 * update live.
 */
import { buildSettings } from "../../settings/pipeline";
import {
  addLogEntry,
  setMigrationsDone,
  setServerUrl,
  setTuiConsoleIntercepted,
  updateService,
} from "../cli-store";
import { findAvailablePort } from "../find-available-port";

export interface ServeOptions {
  port: string;
  home: string;
  skipMigrations: boolean;
  localMode: boolean;
  noTui?: boolean;
}

// Strip ANSI escape codes from a string
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes requires matching control chars
  // oxlint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Intercept console.log/warn/error so in-process server output
 * (e.g. Better Auth errors, library logs) is routed through the CLI store
 * instead of corrupting the Ink TUI rendering.
 *
 * We patch console methods (not process.stdout.write) because Ink manages
 * stdout.write directly for its own rendering.
 */
export function interceptConsoleForTui() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  function capture(...args: unknown[]) {
    const text = args
      .map((a) => (typeof a === "string" ? a : Bun.inspect(a)))
      .join(" ");

    for (const raw of text.split("\n")) {
      const stripped = stripAnsi(raw).trim();
      if (!stripped) continue;
      addLogEntry({
        method: "",
        path: "",
        status: 0,
        duration: 0,
        timestamp: new Date(),
        rawLine: stripped,
      });
    }
  }

  console.log = capture;
  console.warn = capture;
  console.error = capture;
  setTuiConsoleIntercepted(true);

  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    setTuiConsoleIntercepted(false);
  };
}

export async function startServer(options: ServeOptions): Promise<void> {
  const port = await findAvailablePort(Number(options.port));

  const { settings, services } = await buildSettings({
    port: String(port),
    home: options.home,
    localMode: options.localMode,
    skipMigrations: options.skipMigrations,
    noTui: options.noTui,
  });

  for (const s of services) {
    updateService({ name: s.name, status: "ready", port: s.port });
  }
  setMigrationsDone();

  await import("../../index");

  setServerUrl(`http://localhost:${settings.port}`);
}
