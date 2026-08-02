/**
 * Dev mode startup logic.
 *
 * Delegates environment resolution, service startup, and migrations to
 * buildSettings(). Spawns dev servers and reports progress via the CLI
 * store so the Ink UI can update live.
 */
import { join } from "path";
import type { Subprocess } from "bun";
import { buildSettings } from "../../settings/pipeline";
import {
  addLogEntry,
  setMigrationsDone,
  setServerUrl,
  updateService,
} from "../cli-store";
import { findAvailablePort } from "../find-available-port";
import { stripAnsi } from "../strip-ansi";

export interface DevOptions {
  port: string;
  vitePort: string;
  home: string;
  baseUrl?: string;
  skipMigrations: boolean;
  noTui?: boolean;
  localMode: boolean;
  /** When true, hot-reload the managed sandbox daemon. */
  hotReload?: boolean;
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
  const { baseUrl, noTui } = options;

  // Sandbox preview: the daemon injects PORT and proxies the preview to it,
  // expecting HTML at /. Studio's dev front door is Vite (it serves the app and
  // proxies /api → the Bun server); the Bun server alone 404s at / in dev. So
  // in a sandbox we bind Vite to the injected PORT and move the Bun server to
  // an internal port (Vite's proxy target follows PORT). The daemon sets
  // HOST=0.0.0.0 (buildDevEnv) and local `bun run dev` never does, so that's
  // our sandbox tell. Locally the conventional split is preserved (server on
  // --port, Vite on --vite-port).
  const inSandbox = process.env.HOST === "0.0.0.0" && Boolean(process.env.PORT);
  const vitePort = inSandbox ? process.env.PORT! : options.vitePort;
  const publicBaseUrl = baseUrl || `http://localhost:${vitePort}`;

  const port = inSandbox
    ? await findAvailablePort(Number(vitePort) + 1)
    : await findAvailablePort(Number(options.port));

  const { settings, services, managedServiceNames } = await buildSettings({
    port: String(port),
    home: options.home,
    baseUrl: options.baseUrl,
    localMode: options.localMode,
    skipMigrations: options.skipMigrations,
    noTui: options.noTui,
    vitePort: options.vitePort,
  });

  for (const s of services) {
    updateService({ name: s.name, status: "ready", port: s.port });
  }
  setMigrationsDone();

  // ── Spawn dev servers ─────────────────────────────────────────────
  // import.meta.dir = apps/api/src/cli/commands → go up 5 levels to repo root
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..");

  // When TUI is active, pipe stdout/stderr so child output doesn't corrupt
  // Ink's cursor-based rendering. Lines are fed into the CLI store instead.
  const useInherit = noTui === true;
  const child = Bun.spawn(["bun", "run", "dev:servers"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(settings.port),
      VITE_PORT: String(vitePort),
      DATABASE_URL: settings.databaseUrl,
      NATS_URL: settings.natsUrls.join(","),
      NODE_ENV: settings.nodeEnv,
      BASE_URL: publicBaseUrl,
      DECOCMS_LOCAL_MODE: String(settings.localMode),
      DECOCMS_HOME: settings.dataDir,
      DATA_DIR: settings.dataDir,
      DECO_CLI: "1",
      // Object storage (managed MinIO or external S3). Pass from frozen
      // settings so the child server resolves the real S3Service for the
      // message-offload path instead of the DevObjectStorage fallback.
      ...(settings.s3Endpoint
        ? {
            S3_ENDPOINT: settings.s3Endpoint,
            S3_BUCKET: settings.s3Bucket ?? "",
            S3_ACCESS_KEY_ID: settings.s3AccessKeyId ?? "",
            S3_SECRET_ACCESS_KEY: settings.s3SecretAccessKey ?? "",
            S3_FORCE_PATH_STYLE: String(settings.s3ForcePathStyle),
          }
        : {}),
      // Dev NATS operator/JWT config (managed operator-mode NATS). Pass from
      // frozen settings so the child server (which re-derives Settings from
      // env) mints real link-session creds and the cluster authenticates with
      // its creds file — the SAME auth path as production.
      ...(settings.natsPublicUrl &&
      settings.natsAccountJwt &&
      settings.natsAccountSigningKey
        ? {
            NATS_PUBLIC_URL: settings.natsPublicUrl,
            NATS_ACCOUNT_JWT: settings.natsAccountJwt,
            NATS_ACCOUNT_SIGNING_KEY: settings.natsAccountSigningKey,
            NATS_OPERATOR_JWT: settings.natsOperatorJwt ?? "",
            NATS_TUNNEL_PUBLIC_ENABLED: "true",
            ...(settings.natsCredsPath
              ? { NATS_CREDS: settings.natsCredsPath }
              : {}),
          }
        : {}),
    },
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

  const serverUrl = publicBaseUrl;
  setServerUrl(serverUrl);
  updateService({ name: "Vite", status: "ready", port: Number(vitePort) });
  updateService({ name: "API", status: "ready", port: Number(settings.port) });

  const shutdown = async (signal: NodeJS.Signals) => {
    child.kill(signal);
    // Wait for the server to finish graceful shutdown before killing shared
    // services. Otherwise pg dies mid-flight and DBOS / app.shutdown error
    // out connecting to a dead system DB. The server has its own 55s force-
    // exit timer, so this won't hang indefinitely.
    await child.exited;
    if (managedServiceNames.length > 0) {
      const { stopServices } = await import("../../services/ensure-services");
      await stopServices(settings.dataDir);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { port: Number(vitePort), process: child };
}
