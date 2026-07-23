/**
 * Desktop-side link daemon.
 *
 * - Receives an authenticated session from its caller (the CLI's `link`
 *   command obtains one via `ensureSession`).
 * - Runs the tunnel transport (`connectToClusterTunnel`) for cluster→desktop
 *   commands and sandbox proxying, re-resolving the bearer per session.
 * - Spawns the local ingress on `--port` so browsers can reach
 *   `<handle>.localhost:<port>` for sandbox previews.
 * - Dispatches incoming control-plane requests (sandbox lifecycle + the
 *   harness streaming endpoint) into the in-process handler.
 */
import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import {
  postConfig as daemonPostConfig,
  waitForDaemonReady,
} from "@decocms/sandbox/daemon-client";
import { normalizeCoAuthorIdentity } from "@decocms/sandbox/shared";
import { createDefaultDaemonSpawn } from "@decocms/sandbox/daemon-spawn";
import { ensureRclone } from "./ensure-rclone";
import { createControlHandler } from "./control-handler";
import { openOutbox } from "./outbox";
import { connectToClusterTunnel } from "./cluster-connection-tunnel";
import { startLocalIngress } from "./local-ingress";
import { detectCapabilities, startCapabilityReprobe } from "./capabilities";
import { loadOrCreateMachineId } from "./machine-id";
import { getValidSession } from "../cli/lib/get-valid-session";
import type { Session } from "../cli/lib/session";
import {
  openLinkSandboxRegistry,
  registryPathForDataDir,
  type SandboxInspection,
} from "../cli/link-sandbox-registry";
import { createSandboxActions } from "./sandbox-actions";
import {
  createDesktopSandboxProvider,
  type SandboxEvent,
  type SpawnResult,
} from "./user-desktop-provider";
import type { ClusterConnectionHandle } from "./types";

/**
 * Optional observability hooks for the `deco link` TUI. All no-ops when the
 * daemon runs with `--no-tui` (the monitor is simply omitted).
 */
export interface LinkDaemonMonitor {
  onEvent?: (event: SandboxEvent) => void;
  onIngress?: (port: number) => void;
  onCluster?: (status: "connecting" | "linked" | "closed") => void;
  onMachine?: (label: string) => void;
}

export interface StartLinkDaemonOptions {
  port: number;
  clusterBaseUrl: string;
  dataDir: string;
  /**
   * Authenticated session used to bind the WebSocket to the cluster.
   * Callers (e.g. the CLI's `link` command) obtain this via
   * `ensureSession()` before invoking the daemon.
   */
  session: Session;
  /** Optional TUI hooks. Omitted in --no-tui mode. */
  monitor?: LinkDaemonMonitor;
  /**
   * The daemon's own log file descriptor (`link.log`). The parent process
   * intercepts `console.*` onto this fd before calling us, so daemon-level
   * logs (cluster connection, polls, dispatch/relay diagnostics) land here.
   * Also the fallback stdio for spawned sandbox daemons when `perSandboxLogs`
   * is off (managed/dev mode) — otherwise each sandbox logs to its own file.
   */
  logFd?: number;
  /**
   * When true, each spawned sandbox daemon writes its stdout/stderr to its own
   * `<workdir>/tmp/daemon.log` (truncated on every spawn) instead of `logFd` /
   * the terminal — keeping the (very noisy) per-sandbox vite/harness output
   * isolated and co-located with that sandbox's `repo/`. Off in managed/dev
   * mode so the output streams to the parent process.
   */
  perSandboxLogs?: boolean;
  /** Hot-reload sandbox daemons spawned from source. */
  hotReload?: boolean;
}

export interface LinkDaemonHandle {
  stopped: Promise<number>;
  stop: () => Promise<void>;
  stopSandbox: (handle: string) => Promise<void>;
  removeSandbox: (
    handle: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  inspectSandbox: (handle: string) => SandboxInspection | null;
}

export async function startLinkDaemon(
  opts: StartLinkDaemonOptions,
): Promise<LinkDaemonHandle> {
  const hostname = osHostname() || undefined;
  opts.monitor?.onMachine?.(hostname ?? "this machine");

  const innerSpawn = createDefaultDaemonSpawn(opts.dataDir, {
    // Per-sandbox `<workdir>/tmp/daemon.log` when enabled; otherwise fall back
    // to the daemon's log fd / terminal inherit (managed/dev mode).
    outFd: opts.logFd,
    perSandboxLog: opts.perSandboxLogs,
    hotReload: opts.hotReload,
  });
  const registry = openLinkSandboxRegistry({
    path: registryPathForDataDir(opts.dataDir),
    managedSandboxRoot: `${opts.dataDir}/sandboxes`,
  });
  let registryClosed = false;
  const closeRegistry = (): void => {
    if (registryClosed) return;
    registryClosed = true;
    try {
      registry.close();
    } catch {
      /* */
    }
  };

  try {
    // Forward declaration so `resolvePreviewUrl` can read the ingress port
    // once the ingress finishes binding (the ingress's `lookupSandboxPort`
    // calls into the provider, so the two have a circular initialization).
    let ingressPort = 0;
    const provider = createDesktopSandboxProvider({
      dataDir: opts.dataDir,
      registry,
      resolvePreviewUrl: (handle, port) =>
        ingressPort > 0
          ? `http://${handle}.localhost:${ingressPort}`
          : `http://127.0.0.1:${port}`,
      spawnDaemon: async (args): Promise<SpawnResult> => {
        const env: Record<string, string> = {
          DAEMON_BOOT_ID: randomUUID(),
          APP_ROOT: args.workdir,
          PROXY_PORT: String(args.port),
          DAEMON_TOKEN: args.daemonToken,
          // Message-offload SSRF allowlist, pushed by the cluster via the ensure
          // body (trusted config — never a request frame). The daemon reads
          // these at boot (`packages/sandbox/daemon/entry.ts`) and rejects any
          // offload fetch whose host isn't listed. Empty = fail closed.
          OFFLOAD_ALLOWED_HOSTS: args.offloadAllowedHosts.join(","),
          ...(args.offloadAllowSameHostDev
            ? { OFFLOAD_ALLOW_SAME_HOST_DEV: "1" }
            : {}),
        };
        // org-fs mounting needs BOTH the config and a real rclone binary. Ensure
        // rclone (downloaded + cached once) only when a mount is requested; if it
        // can't be obtained, leave both unset so the daemon skips mounting.
        if (args.orgFsConfigJson) {
          const rclonePath = await ensureRclone(opts.dataDir);
          if (rclonePath) {
            env.ORGFS_CONFIG = args.orgFsConfigJson;
            env.ORGFS_RCLONE_PATH = rclonePath;
          }
        }
        const proc = await innerSpawn({
          workdir: args.workdir,
          env,
          daemonPort: args.port,
        });
        return {
          port: args.port,
          kill: (sig) => proc.kill(sig),
          exited: proc.exited.then(() => undefined),
        };
      },
      postConfig: async (port, devPort, config, daemonToken) => {
        // Daemon's TenantConfig wire shape is `{ git, application }`. We
        // always pin `application.port` to the link-allocated devPort so
        // co-tenant sandboxes can't collide on the host network; the
        // caller-supplied workload only drives runtime + packageManager
        // (without these the orchestrator falls through to lockfile
        // autodetect, which on a repo with `yarn.lock` picks yarn — a
        // package manager the desktop daemon can't reliably PATH-shim).
        const application: Record<string, unknown> = { port: devPort };
        if (config.workload) {
          application.runtime = config.workload.runtime;
          application.packageManager = {
            name: config.workload.packageManager,
            ...(config.workload.packageManagerPath
              ? { path: config.workload.packageManagerPath }
              : {}),
          };
        }
        const payload: Record<string, unknown> = { application };
        const operator = normalizeCoAuthorIdentity(config.operator ?? null);
        if (operator) {
          payload.operator = operator;
        }
        if (config.repo) {
          payload.git = {
            repository: {
              cloneUrl: config.repo.cloneUrl,
              branch: config.repo.branch,
              ...(config.repo.submoduleCredentials &&
              config.repo.submoduleCredentials.length > 0
                ? { submoduleCredentials: config.repo.submoduleCredentials }
                : {}),
            },
            ...(config.repo.userName && config.repo.userEmail
              ? {
                  identity: {
                    userName: config.repo.userName,
                    userEmail: config.repo.userEmail,
                  },
                }
              : {}),
          };
        }
        await daemonPostConfig(
          `http://127.0.0.1:${port}`,
          daemonToken,
          payload,
        );
      },
      waitForHealth: async (port) => {
        await waitForDaemonReady(`http://127.0.0.1:${port}`);
      },
      maxSandboxes: 20,
      onEvent: opts.monitor?.onEvent,
    });

    const ingress = await startLocalIngress({
      port: opts.port,
      lookupSandboxPort: (handle) => provider.proxyPort(handle),
    });
    ingressPort = ingress.port;
    console.log(
      `Local ingress listening on http://127.0.0.1:${ingress.port} (use http://<handle>.localhost:${ingress.port}/)`,
    );
    opts.monitor?.onIngress?.(ingress.port);

    // The control handler reverse-proxies `/_sandbox/<handle>/*` to each
    // spawned sandbox daemon's local port. The provider exposes `proxyPort`
    // and `acquireDispatch` to map handle → port and track in-flight calls.
    const controlHandler = createControlHandler({ provider });

    // Shared token resolver. Re-resolves (and refreshes) the bearer before each
    // tunnel session so a stale startup token doesn't spin forever on a 401.
    const getAccessToken = async (): Promise<string> => {
      const fresh = await getValidSession({
        dataDir: opts.dataDir,
        target: opts.clusterBaseUrl,
      });
      if (!fresh) {
        throw Object.assign(
          new Error(
            `Session for ${opts.clusterBaseUrl} is no longer valid — run \`deco auth login --target ${opts.clusterBaseUrl}\` and restart \`deco link\`.`,
          ),
          { fatal: true },
        );
      }
      return fresh.accessToken;
    };

    // The daemon's identity + capabilities are served live over the tunnel via
    // `GET /api/links/status`, which the cluster probes when resolving a dispatch
    // target and checking capabilities.
    const machineId = await loadOrCreateMachineId(opts.dataDir);
    const cliVersion = process.env.npm_package_version ?? "0.0.0";
    const capabilities = await detectCapabilities();
    // While a CLI capability (claude-code / codex) is missing, re-probe every
    // minute so installing or signing into the CLI after `decocms link` started
    // is picked up without a daemon restart. The status handler reads the shared,
    // grow-only array, so the next probe advertises the change.
    const stopReprobe = startCapabilityReprobe(capabilities, {
      onChange: (added) => {
        console.log(
          `[link-daemon] capabilities detected: +${added.join(",")} (now: ${capabilities.join(",")})`,
        );
      },
    });
    // Durable uplink outbox (spec §5.1). One DB per daemon under the leaf data
    // dir (DATA_DIR is the leaf — do NOT append `.deco`; sandboxes live at
    // `$DATA_DIR/link/sandboxes/...`). Within a session it buffers the unacked
    // relay prefix for resend-on-reconnect.
    const outbox = openOutbox({ path: `${opts.dataDir}/link/outbox.sqlite` });
    // Boot sweep: a run can't survive a daemon restart (its sandbox + harness die
    // with it), so any rows left from a prior session are dead. Clear them so a
    // new session never inherits a wedged outbox (the field leak that filled the
    // 64 MiB cap with 11 days of failed runs and bricked the relay).
    outbox.clear();

    // `shutdown` is declared below (it needs `cluster` in scope); the control
    // poller can in principle deliver a frame before that line runs, so route
    // the callback through a mutable holder instead of capturing `shutdown`
    // directly (TDZ).
    let onRemoteShutdown: () => void = () => {};

    // Daemon-lifetime signal: bounds in-flight runs. Aborted only on shutdown —
    // NOT on tunnel-session renewal (renewal must not kill a running build).
    const runLifetime = new AbortController();

    const clusterInput = {
      clusterBaseUrl: opts.clusterBaseUrl,
      getAccessToken,
      provider,
      outbox,
      // The in-process control handler also serves tunnel `/_sandbox/*`
      // requests (vm-events SSE, control RPC, vm-tools) locally.
      controlHandler,
      capabilities,
      machineId,
      cliVersion,
      previewPort: ingress.port,
      onConnected: () => {
        opts.monitor?.onCluster?.("linked");
        console.log(`Linked to ${opts.clusterBaseUrl}`);
      },
      onShutdown: () => onRemoteShutdown(),
      runLifetimeSignal: runLifetime.signal,
    };

    console.log(
      `[link-daemon] transport=tunnel cluster=${opts.clusterBaseUrl}`,
    );
    const cluster: ClusterConnectionHandle =
      await connectToClusterTunnel(clusterInput);
    console.log("[link-daemon] active transport=tunnel");

    let resolveStopped!: (code: number) => void;
    const stopped = new Promise<number>((r) => {
      resolveStopped = r;
    });
    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      runLifetime.abort();
      console.log("\nShutting down…");
      stopReprobe();
      try {
        await cluster.close();
      } catch {
        /* */
      }
      try {
        await ingress.stop();
      } catch {
        /* */
      }
      try {
        await provider.shutdown();
      } catch {
        /* */
      }
      try {
        outbox.close();
      } catch {
        /* */
      }
      closeRegistry();
      resolveStopped(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    onRemoteShutdown = () => {
      console.log(
        "Disconnect requested from the Studio web UI — shutting down. Run `bunx decocms@latest link` to reconnect.",
      );
      void shutdown();
    };

    void cluster.closed.then(() => {
      opts.monitor?.onCluster?.("closed");
      if (!shuttingDown) {
        console.error("Cluster connection closed permanently; exiting.");
        void shutdown();
      }
    });

    const sandboxActions = createSandboxActions({
      provider,
      registry,
      dataDir: opts.dataDir,
    });

    return {
      stopped,
      stop: shutdown,
      stopSandbox: sandboxActions.stopSandbox,
      removeSandbox: sandboxActions.removeSandbox,
      inspectSandbox: sandboxActions.inspectSandbox,
    };
  } catch (err) {
    closeRegistry();
    throw err;
  }
}
