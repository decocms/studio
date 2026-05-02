/**
 * Server startup logic extracted from cli.ts.
 *
 * Delegates environment resolution, service startup, and migrations to
 * buildSettings(). Reports progress via the CLI store so the Ink UI can
 * update live.
 */
import { join } from "path";
import { buildSettings } from "../../settings/pipeline";
import {
  addLogEntry,
  setEnv,
  setMigrationsDone,
  setServerUrl,
  setTuiConsoleIntercepted,
  updateService,
} from "../cli-store";
import { findAvailablePort } from "../find-available-port";
import { buildChildEnv } from "../build-child-env";

export interface ServeOptions {
  port: string;
  home: string;
  skipMigrations: boolean;
  localMode: boolean;
  noTui?: boolean;
  numThreads?: number;
}

// Strip ANSI escape codes from a string
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes requires matching control chars
  // oxlint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Pipe a readable stream line-by-line into the CLI store log entries.
 * Used to route worker process stdout/stderr through the TUI instead of
 * writing directly to stdout (which would corrupt Ink's cursor rendering).
 */
function pipeToLogStore(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function processLines() {
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const stripped = stripAnsi(raw)
        .replace(/^\[\d+\]\s*/, "")
        .trim();
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

  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      processLines();
    }
    if (buffer.trim()) {
      const stripped = stripAnsi(buffer)
        .replace(/^\[\d+\]\s*/, "")
        .trim();
      if (stripped) {
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
  })();
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

export async function startServer(
  options: ServeOptions,
): Promise<{ port: number }> {
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
  setEnv(settings);
  setMigrationsDone();

  const numThreads = options.numThreads ?? 1;
  const isLinux = process.platform === "linux";

  if (numThreads > 1 && !isLinux) {
    console.warn(
      "--num-threads is only supported on Linux (SO_REUSEPORT); running with 1 thread.",
    );
  }

  if (numThreads > 1 && isLinux) {
    // Determine the correct server entry point for workers:
    //   Dev:  serve.ts lives at apps/mesh/src/cli/commands/ → ../../index.ts
    //   Prod: serve.ts is bundled into dist/server/cli.js   → server.js (same dir)
    const isDev = import.meta.path.endsWith(".ts");
    const serverEntry = isDev
      ? join(import.meta.dir, "../../index.ts")
      : join(import.meta.dir, "server.js");

    const useInherit = options.noTui === true;
    const workerEnv = buildChildEnv(settings, {
      DECOCMS_IS_WORKER: "1",
      REUSE_PORT: "true",
    });

    const workers: import("bun").Subprocess[] = [];

    for (let i = 1; i < numThreads; i++) {
      const worker = Bun.spawn([process.execPath, serverEntry], {
        env: workerEnv,
        stdio: [
          "inherit",
          useInherit ? "inherit" : "pipe",
          useInherit ? "inherit" : "pipe",
        ],
      });
      workers.push(worker);
      if (!useInherit) {
        pipeToLogStore(worker.stdout as ReadableStream<Uint8Array>);
        pipeToLogStore(worker.stderr as ReadableStream<Uint8Array>);
      }
    }

    // Signal the primary process to also use reusePort in Bun.serve()
    process.env.REUSE_PORT = "true";

    // Propagate shutdown signals to all worker processes
    const killWorkers = () => {
      for (const w of workers) w.kill();
    };
    process.on("SIGINT", killWorkers);
    process.on("SIGTERM", killWorkers);
    process.on("exit", killWorkers);
  }

  // Boot the primary server process (in-process, as before)
  await import("../../index");

  setServerUrl(`http://localhost:${settings.port}`);
  return { port: Number(settings.port) };
}
