/**
 * Dev mode startup logic.
 *
 * Loads .env, starts services, runs migrations, and spawns dev servers.
 * Reports progress via the CLI store so the Ink UI can update live.
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { Subprocess } from "bun";
import {
  addLogEntry,
  setEnv,
  setMigrationsDone,
  setServerUrl,
  updateService,
} from "../cli-store";
import type { ServiceStatus } from "../header";

export interface DevOptions {
  port: string;
  vitePort: string;
  home: string;
  baseUrl?: string;
  skipMigrations: boolean;
  envFile?: string;
  noTui?: boolean;
  localMode: boolean;
}

function loadDotEnv(path: string): Record<string, string> {
  try {
    const result: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      result[key] = val;
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

// Strip ANSI escape codes from a string
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes requires matching control chars
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Pipe a readable stream line-by-line into the CLI store log entries.
 * Lines are stripped of ANSI codes and concurrently prefixes like "[0] " / "[1] ".
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

export async function startDevServer(
  options: DevOptions,
): Promise<{ port: number; process: Subprocess }> {
  const {
    port,
    vitePort,
    home,
    baseUrl,
    skipMigrations,
    envFile,
    noTui,
    localMode,
  } = options;

  // ── .env loading ────────────────────────────────────────────────────
  if (envFile) {
    const dotEnv = loadDotEnv(envFile);
    for (const [key, value] of Object.entries(dotEnv)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }

  // ── Environment ─────────────────────────────────────────────────────
  if (noTui) {
    process.env.DECO_NO_TUI = "true";
  }
  process.env.DECOCMS_HOME = home;
  process.env.DATA_DIR = home;
  process.env.PORT = port;
  process.env.VITE_PORT = vitePort;
  process.env.NODE_ENV = "development";
  process.env.DECO_CLI = "1";
  process.env.DECOCMS_LOCAL_MODE = localMode ? "true" : "false";

  if (baseUrl) {
    process.env.BASE_URL = baseUrl;
  }

  // ── Services ──────────────────────────────────────────────────────
  const { ensureServices } = await import("../../services/ensure-services");
  const services = await ensureServices(home);

  for (const s of services) {
    const svc: ServiceStatus = {
      name: s.name === "PostgreSQL" ? "Postgres" : s.name,
      status: "ready",
      port: s.port,
    };
    updateService(svc);
  }

  // ── Migrations ────────────────────────────────────────────────────
  if (!skipMigrations) {
    try {
      const { migrateToLatest } = await import("../../database/migrate");
      await migrateToLatest({ keepOpen: true });
    } catch (error) {
      console.error("Failed to run migrations:", error);
      process.exit(1);
    }
  }
  setMigrationsDone();

  // ── Env ───────────────────────────────────────────────────────────
  const { env } = await import("../../env");
  setEnv(env);

  // ── Spawn dev servers ─────────────────────────────────────────────
  // import.meta.dir = apps/mesh/src/cli/commands → go up 5 levels to repo root
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..");

  // When TUI is active, pipe stdout/stderr so child output doesn't corrupt
  // Ink's cursor-based rendering. Lines are fed into the CLI store instead.
  const useInherit = noTui === true;
  const child = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:servers"], {
    cwd: repoRoot,
    env: process.env,
    stdio: [
      "inherit",
      useInherit ? "inherit" : "pipe",
      useInherit ? "inherit" : "pipe",
    ],
  });

  if (!useInherit) {
    pipeToLogStore(child.stdout as ReadableStream<Uint8Array>);
    pipeToLogStore(child.stderr as ReadableStream<Uint8Array>);
  }

  const serverUrl = baseUrl || `http://localhost:${port}`;
  setServerUrl(serverUrl);
  updateService({ name: "Vite", status: "ready", port: Number(vitePort) });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  return { port: Number(port), process: child };
}
