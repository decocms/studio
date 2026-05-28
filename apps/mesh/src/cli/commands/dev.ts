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
  setEnv,
  setMigrationsDone,
  setServerUrl,
  updateService,
} from "../cli-store";
import { findAvailablePort } from "../find-available-port";
import { waitForPort } from "../lib/port-wait";

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
}

// Strip ANSI escape codes from a string
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes requires matching control chars
  // oxlint-disable-next-line no-control-regex
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
  const { vitePort, baseUrl, noTui } = options;

  const port = await findAvailablePort(Number(options.port));

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
  setEnv(settings);
  setMigrationsDone();

  // ── Spawn dev servers ─────────────────────────────────────────────
  // import.meta.dir = apps/mesh/src/cli/commands → go up 5 levels to repo root
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..");

  // Pre-compute the link's data dir. The dir lives in tmpdir — NOT under
  // settings.dataDir, which is inside the mesh repo. Sandbox clones go into
  // `<DATA_DIR>/sandboxes/<handle>/repo`; when that parent is itself a git
  // repo (e.g. `~/code/mesh/...`) git's parent-walk hits the outer .git,
  // refuses to clone, and the daemon crashes mid-bootstrap. Keying by
  // workspace slug isolates concurrent worktrees.
  const slug =
    process.env.WORKTREE_SLUG ??
    process.env.CONDUCTOR_WORKSPACE_NAME ??
    "default";
  const linkDataDir = join(tmpdir(), `decocms-dev-link-${slug}`);

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
      DECOCMS_LOCAL_MODE: String(settings.localMode),
      DECOCMS_HOME: settings.dataDir,
      DATA_DIR: settings.dataDir,
      DECO_CLI: "1",
      ...(settings.baseUrl ? { BASE_URL: settings.baseUrl } : {}),
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

  const serverUrl = baseUrl || `http://localhost:${settings.port}`;
  setServerUrl(serverUrl);
  updateService({ name: "Vite", status: "ready", port: Number(vitePort) });

  // ── Auto-spawn `deco link` (opt-in) ──────────────────────────────
  // Gated on --local-sandbox-provider. When set, once the cluster is up
  // on :PORT, spawn the link daemon so the dev session exercises the
  // remote-cli + desktop code paths end-to-end. The link connects via
  // WS using its persisted OAuth session.
  //
  // The link is tracked like postgres/nats: dynamic port, state file at
  // <home>/services/link/state.json, owned-process verification on
  // shutdown. `services down` (or our shutdown handler below) tears it
  // down. The DATA_DIR lives OUTSIDE the mesh repo: the daemon clones
  // user repos into `<DATA_DIR>/sandboxes/<handle>/repo`, and if that
  // path is nested under another git repo (this one) git's parent-walk
  // hits the outer .git, refuses to clone, and the daemon crashes
  // mid-bootstrap. The tmpdir-rooted path keyed by workspace slug also
  // keeps concurrent worktrees from fighting over the same sandboxes dir.
  const linkChild: Promise<Subprocess | null> = !options.localSandboxProvider
    ? Promise.resolve(null)
    : (async (): Promise<Subprocess | null> => {
        const { ensureLink } = await import("../../services/ensure-services");
        try {
          const { info, proc } = await ensureLink({
            home: settings.dataDir,
            clusterUrl: serverUrl,
            linkDataDir,
            repoRoot,
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
              // Wait for the cluster's HTTP port before spawning the link
              // daemon so it can immediately reach the WS gateway.
              await waitForPort(Number(settings.port), { intervalMs: 500 });
            },
          });
          // Mark Sandbox ready once the link binary's HTTP server accepts
          // connections on its port. Fire-and-forget; if the link never
          // comes up (e.g. no admin user yet for session bootstrap), the
          // status stays "pending" and the user sees a spinner — useful
          // signal that something's wrong rather than silent failure.
          void waitForPort(info.port, { intervalMs: 500 })
            .then(() => {
              updateService({
                name: "Sandbox",
                status: "ready",
                port: info.port,
              });
            })
            .catch(() => {
              /* link never came up — leave status pending as a signal */
            });
          return proc;
        } catch (err) {
          addLogEntry({
            method: "",
            path: "",
            status: 0,
            duration: 0,
            timestamp: new Date(),
            rawLine: `[link] failed to start: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          return null;
        }
      })();

  const shutdown = async (signal: NodeJS.Signals) => {
    // Wait for any in-flight link spawn to settle so we don't orphan a
    // process that gets spawned right after we've torn down everything
    // else. On a normal shutdown the spawn has long since resolved.
    await linkChild.catch(() => null);
    // Stop the link first — it talks to the cluster on shutdown
    // (DELETE /api/links/me), so giving it a window before we tear down
    // the API server reduces orphaned registry entries. stopLink reads
    // the state file written by ensureLink, signals the daemon, waits
    // for exit, then removes the state file.
    if (options.localSandboxProvider) {
      const { stopLink } = await import("../../services/ensure-services");
      try {
        await stopLink(settings.dataDir);
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

  return { port: Number(settings.port), process: child };
}
