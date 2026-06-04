/**
 * Dev mode startup logic.
 *
 * Delegates environment resolution, service startup, and migrations to
 * buildSettings(). Spawns dev servers and reports progress via the CLI
 * store so the Ink UI can update live.
 */
import { tmpdir } from "node:os";
import { join } from "path";
import { sleep } from "@decocms/std";
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

export interface DevOptions {
  port: string;
  apiPort: string;
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

// Strip ALL terminal control bytes from child output so a child can't drive
// our cursor. The previous regex only stripped SGR color codes
// (`\x1b[…m`) — cursor moves (`\x1b[?25l`, `\x1b[K`, `\x1b[<n>A`), screen
// clears, OSC title sets, and bare C0/C1 control chars all slipped through
// into `rawLine` and got re-emitted by Ink as `<Text>` content, corrupting
// the TUI's cursor model. Here we treat children's stdout as untrusted bytes
// and reduce them to printable text (plus TAB) before display.
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control sequences requires matching control chars
  // oxlint-disable-next-line no-control-regex
  return (
    str
      // CSI: ESC [ params intermediates final — covers SGR, cursor moves,
      // erase, scroll, mode set/reset, etc.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // OSC: ESC ] ... (BEL | ESC \) — covers terminal title, hyperlinks
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // Other ESC-introduced sequences (single-shift, charset select, etc.)
      .replace(/\x1b[@-Z\\-_]/g, "")
      // C0 control chars except TAB (0x09) and LF (0x0a), plus DEL (0x7f)
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      // C1 control chars (8-bit equivalents of ESC sequences)
      .replace(/[\x80-\x9f]/g, "")
  );
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
  const { apiPort, baseUrl, noTui } = options;

  const userPort = await findAvailablePort(Number(options.port));
  let apiPortResolved = await findAvailablePort(Number(apiPort));
  // Guard against the API port colliding with the user-facing port. Both
  // calls above only check availability at that instant — neither port is
  // bound yet — so if the user passes the same value (or the requested
  // ports happen to resolve to the same number) both children would race
  // for the same socket. Bump until distinct.
  while (apiPortResolved === userPort) {
    apiPortResolved = await findAvailablePort(apiPortResolved + 1);
  }

  const { settings, services, managedServiceNames } = await buildSettings({
    port: String(userPort),
    home: options.home,
    baseUrl: options.baseUrl,
    localMode: options.localMode,
    skipMigrations: options.skipMigrations,
    noTui: options.noTui,
    apiPort: String(apiPortResolved),
  });

  for (const s of services) {
    updateService({ name: s.name, status: "ready", port: s.port });
  }
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

  // Shared env for both children — each gets a distinct PORT.
  // API_PORT is set on BOTH so vite.config.ts can read it as the
  // proxy target.
  const sharedEnv: Record<string, string> = {
    ...process.env,
    API_PORT: String(apiPortResolved),
    DATABASE_URL: settings.databaseUrl,
    NATS_URL: settings.natsUrls.join(","),
    NODE_ENV: settings.nodeEnv,
    DECOCMS_LOCAL_MODE: String(settings.localMode),
    DECOCMS_HOME: settings.dataDir,
    DATA_DIR: settings.dataDir,
    DECO_CLI: "1",
    // Tell the cluster where to write the dev-link session file when
    // local-sandbox-provider is on, so the auto-spawned link daemon
    // finds session.json under its DATA_DIR.
    ...(options.localSandboxProvider
      ? { DEV_LINK_SESSION_PATH: join(linkDataDir, "session.json") }
      : {}),
    ...(settings.baseUrl ? { BASE_URL: settings.baseUrl } : {}),
  };

  // Sever children's access to the parent TTY when the TUI is active.
  // Ink owns stdout in raw mode; any child that touches the TTY (Vite's
  // "press r to restart", Bun's `--hot`, anything calling tcsetattr) would
  // toggle termios out from under Ink and visibly flicker the prompt.
  // With `"ignore"` the child sees /dev/null on stdin, can't detect a TTY,
  // and can't fight us for the cursor — the studio remains hermetic
  // regardless of what 3p code we spawn under it. `noTui` keeps inherit
  // because the user wants raw passthrough in that mode.
  const childStdin: "inherit" | "ignore" = useInherit ? "inherit" : "ignore";

  // Vite child — user-facing. Binds PORT (userPort). Vite reads
  // process.env.PORT natively for its bind port.
  const viteChild = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:client"], {
    cwd: repoRoot,
    env: { ...sharedEnv, PORT: String(userPort) },
    stdio: [
      childStdin,
      useInherit ? "inherit" : "pipe",
      useInherit ? "inherit" : "pipe",
    ],
  });

  // API child — internal. Binds API_PORT. mesh's
  // src/index.ts reads process.env.PORT for its bind port.
  const apiChild = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:server"], {
    cwd: repoRoot,
    env: { ...sharedEnv, PORT: String(apiPortResolved) },
    stdio: [
      childStdin,
      useInherit ? "inherit" : "pipe",
      useInherit ? "inherit" : "pipe",
    ],
  });

  if (!useInherit) {
    pipeToLogStore(viteChild.stdout as ReadableStream<Uint8Array>);
    pipeToLogStore(viteChild.stderr as ReadableStream<Uint8Array>);
    pipeToLogStore(apiChild.stdout as ReadableStream<Uint8Array>);
    pipeToLogStore(apiChild.stderr as ReadableStream<Uint8Array>);
  }

  // Cross-link the two children: if either exits, kill the other so the
  // parent's `await result.process.exited` resolves promptly and no child
  // is orphaned. Without this, a Vite crash would leave the parent
  // waiting on apiChild.exited forever; an API crash would orphan
  // viteChild when the parent process.exit's.
  void viteChild.exited.then((code) => {
    if (code !== null && code !== 0) {
      console.error(`[dev] vite child exited with code ${code}`);
    }
    try {
      apiChild.kill("SIGTERM");
    } catch {
      // already gone
    }
  });
  void apiChild.exited.then(() => {
    try {
      viteChild.kill("SIGTERM");
    } catch {
      // already gone
    }
  });

  // Treat the API child as the "main" child for shutdown/exit tracking.
  const child = apiChild;

  const serverUrl = baseUrl || `http://localhost:${userPort}`;
  setServerUrl(serverUrl);
  updateService({ name: "Web", status: "ready", port: userPort });
  updateService({
    name: "API",
    status: "ready",
    port: apiPortResolved,
  });

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
          clusterUrl: serverUrl,
          linkDataDir,
          repoRoot,
          signal: linkAbort.signal,
          stdio: [
            childStdin,
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
            // Then wait for the cluster's `bootstrapDevLinkSession` to drop
            // session.json into linkDataDir, since the link CLI's
            // `ensureSession` errors out (non-TTY auto-spawn) if it's missing.
            const sessionPath = join(linkDataDir, "session.json");
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
              if (await Bun.file(sessionPath).exists()) return;
              await sleep(250);
            }
            throw new Error(
              `[dev-link] session.json not minted at ${sessionPath} after 30s — check cluster logs for [dev-link] errors`,
            );
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
    // Stop the link next — it talks to the cluster on shutdown
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
    // Wait for both children to finish graceful shutdown before killing
    // shared services. Otherwise pg dies mid-flight and DBOS / app.shutdown
    // error out connecting to a dead system DB. The API child has a 55s
    // force-exit timer covering the worst case; Vite exits quickly on
    // SIGTERM in practice.
    viteChild.kill(signal);
    apiChild.kill(signal);
    await Promise.all([viteChild.exited, apiChild.exited]);
    if (managedServiceNames.length > 0) {
      const { stopServices } = await import("../../services/ensure-services");
      await stopServices(settings.dataDir);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { port: userPort, process: child };
}
