/**
 * Dev mode startup logic.
 *
 * Delegates environment resolution, service startup, and migrations to
 * buildSettings(). Spawns dev servers and reports progress via the CLI
 * store so the Ink UI can update live.
 */
import { tmpdir } from "node:os";
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
import { waitForPort } from "../lib/port-wait";
import { stripAnsi } from "../strip-ansi";

export interface DevOptions {
  port: string;
  vitePort: string;
  home: string;
  baseUrl?: string;
  skipMigrations: boolean;
  noTui?: boolean;
  localMode: boolean;
  /** When true, auto-spawn the link daemon (`deco link`) so the
   *  desktop sandbox provider has a live target. Default false —
   *  `dev:conductor` opts in. */
  localSandboxProvider: boolean;
  /** When true, hot-reload the managed link daemon and sandbox daemons. */
  hotReload?: boolean;
  /** Dev-only: route managed user-desktop link traffic through ToxiProxy. */
  devLinkToxiProxy?: boolean;
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
  // import.meta.dir = apps/mesh/src/cli/commands → go up 5 levels to repo root
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..");

  // Pre-compute the link's data dir. The dir lives in tmpdir — NOT under
  // settings.dataDir, which is inside the studio repo. Sandbox clones go into
  // `<DATA_DIR>/sandboxes/<handle>/repo`; when that parent is itself a git
  // repo (e.g. `~/code/studio/...`) git's parent-walk hits the outer .git,
  // refuses to clone, and the daemon crashes mid-bootstrap. Keying by
  // workspace slug isolates concurrent worktrees.
  const slug =
    process.env.WORKTREE_SLUG ??
    process.env.CONDUCTOR_WORKSPACE_NAME ??
    "default";
  // Local mode mints an API-key session into an isolated tmpdir so sandbox
  // clones never nest inside the studio repo's .git. Non-local mode reuses
  // DECOCMS_HOME so the auto-spawned link registers as the same OAuth user
  // logged into the browser (e.g. tavano@deco.cx).
  const linkDataDir = options.localMode
    ? join(tmpdir(), `decocms-dev-link-${slug}`)
    : settings.dataDir;

  // When TUI is active, pipe stdout/stderr so child output doesn't corrupt
  // Ink's cursor-based rendering. Lines are fed into the CLI store instead.
  const useInherit = noTui === true;
  const child = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:servers"], {
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
      // Local mode only: tell the cluster to mint an API-key session for the
      // auto-spawned link. Non-local mode uses the developer's OAuth session
      // from DECOCMS_HOME instead (see ensureDevLinkSession).
      ...(options.localSandboxProvider && options.localMode
        ? { DEV_LINK_SESSION_PATH: join(linkDataDir, "session.json") }
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

  let linkClusterUrl = serverUrl;
  let stopToxiProxy: (() => Promise<void>) | null = null;
  try {
    if (options.localSandboxProvider && options.devLinkToxiProxy) {
      const {
        DEV_LINK_TOXIPROXY_SERVICE_NAME,
        ensureDevLinkToxiProxy,
        resolveDevLinkClusterUrl,
      } = await import("../lib/dev-link-toxiproxy");
      const apiPort = await findAvailablePort(18474);
      const listenPort = await findAvailablePort(18480);
      const toxiproxy = await ensureDevLinkToxiProxy({
        serverUrl,
        apiPort,
        listenPort,
      });
      stopToxiProxy = toxiproxy.stop;
      linkClusterUrl = resolveDevLinkClusterUrl({
        serverUrl,
        toxiproxy: toxiproxy.config,
      });
      updateService({
        name: DEV_LINK_TOXIPROXY_SERVICE_NAME,
        status: "ready",
        port: listenPort,
      });
      addLogEntry({
        method: "",
        path: "",
        status: 0,
        duration: 0,
        timestamp: new Date(),
        rawLine: toxiproxy.config.logLine,
      });
    }
  } catch (error) {
    if (stopToxiProxy) {
      await stopToxiProxy().catch(() => null);
    }
    child.kill("SIGTERM");
    await child.exited.catch(() => null);
    if (managedServiceNames.length > 0) {
      try {
        const { stopServices } = await import("../../services/ensure-services");
        await stopServices(settings.dataDir);
      } catch {
        /* best-effort cleanup; preserve the original startup error */
      }
    }
    throw error;
  }

  // ── Auto-spawn `deco link` (opt-in) ──────────────────────────────
  // Gated on --local-sandbox-provider. When set, once the cluster is up
  // on :PORT, spawn the link daemon so the dev session exercises the
  // remote-cli + desktop code paths end-to-end. The link connects via
  // WS using its persisted OAuth session.
  //
  // The link is tracked like postgres/nats: dynamic port, state file at
  // <home>/services/link/state.json, owned-process verification on
  // shutdown. `services down` (or our shutdown handler below) tears it
  // down. The DATA_DIR lives OUTSIDE the studio repo: the daemon clones
  // user repos into `<DATA_DIR>/sandboxes/<handle>/repo`, and if that
  // path is nested under another git repo (this one) git's parent-walk
  // hits the outer .git, refuses to clone, and the daemon crashes
  // mid-bootstrap. The tmpdir-rooted path keyed by workspace slug also
  // keeps concurrent worktrees from fighting over the same sandboxes dir.
  //
  // Supervise the daemon for the whole session rather than spawning it once.
  // The daemon's WS self-heals (cluster-connection reconnects forever); only a
  // process exit is unrecoverable, and an unsupervised exit silently expires
  // the NATS link claim (60s TTL) → every user-desktop dispatch 409s with
  // `user_desktop_link_offline` while the UI still reads "ready". superviseLink
  // respawns on exit with backoff and drives Sandbox status from real liveness.
  const linkAbort = new AbortController();
  const linkSupervisor: Promise<void> = !options.localSandboxProvider
    ? Promise.resolve()
    : (async () => {
        const { superviseLink } = await import(
          "../../services/ensure-services"
        );
        await superviseLink({
          home: settings.dataDir,
          clusterUrl: linkClusterUrl,
          linkDataDir,
          repoRoot,
          hotReload: options.hotReload,
          signal: linkAbort.signal,
          stdio: [
            "inherit",
            useInherit ? "inherit" : "pipe",
            useInherit ? "inherit" : "pipe",
          ],
          onSpawn: (proc) => {
            if (useInherit) return;
            pipeToLogStore(proc.stdout as ReadableStream<Uint8Array>);
            pipeToLogStore(proc.stderr as ReadableStream<Uint8Array>);
          },
          beforeSpawn: async () => {
            await waitForPort(Number(settings.port), { intervalMs: 500 });
            const { ensureDevLinkSession } = await import(
              "../lib/ensure-dev-link-session"
            );
            await ensureDevLinkSession({
              localMode: options.localMode,
              linkDataDir,
              studioDataDir: settings.dataDir,
              serverUrl: linkClusterUrl,
              isInteractive: Boolean(process.stdin.isTTY),
            });
          },
          // Drive Sandbox status from real liveness: "ready" when the daemon's
          // HTTP port answers, "pending" (spinner) while it's down/respawning
          // so a crash isn't masked by a stale "ready".
          onReady: (port) =>
            updateService({ name: "Sandbox", status: "ready", port }),
          onDown: () =>
            updateService({ name: "Sandbox", status: "pending", port: 0 }),
          onLog: (rawLine) =>
            addLogEntry({
              method: "",
              path: "",
              status: 0,
              duration: 0,
              timestamp: new Date(),
              rawLine,
            }),
        });
      })();

  const shutdown = async (signal: NodeJS.Signals) => {
    // Stop the supervisor first so it can't respawn the daemon we're about to
    // tear down, then wait for its loop to settle (it may be mid-spawn). This
    // also prevents orphaning a process spawned right as we shut down.
    linkAbort.abort();
    await linkSupervisor.catch(() => null);
    // Stop the link next — signal the daemon process (stopLink reads the
    // state file written by ensureLink, signals the daemon, waits for
    // exit, then removes the state file). There is no HTTP DELETE endpoint;
    // the link-claim entry expires via the 60 s NATS-KV TTL after the
    // process exits. Stopping before the API server reduces the window
    // where polls arrive but NATS is already gone.
    if (options.localSandboxProvider) {
      const { stopLink } = await import("../../services/ensure-services");
      try {
        await stopLink(settings.dataDir);
      } catch {
        /* best-effort */
      }
    }
    if (stopToxiProxy) {
      try {
        await stopToxiProxy();
      } catch {
        /* best-effort */
      }
    }
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
