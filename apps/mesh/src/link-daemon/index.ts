/**
 * Desktop-side link daemon.
 *
 * Boots a local Bun.serve, opens a Warp tunnel (unless `noTunnel`),
 * registers with the cluster's `/api/links` to receive a `linkSecret`,
 * then serves the control-plane HMAC handler (sandbox lifecycle +
 * reverse proxy). On stop (SIGINT/SIGTERM or `handle.stop()`) it
 * gracefully deregisters, kills any sandboxes, and closes the tunnel.
 *
 * The OAuth session is read from `<dataDir>/session.json` (the
 * format `deco auth login` writes).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import {
  postConfig as daemonPostConfig,
  waitForDaemonReady,
} from "@decocms/sandbox/daemon-client";
import { createDefaultDaemonSpawn } from "@decocms/sandbox/daemon-spawn";
import { LINK_PROTOCOL_VERSION } from "@/links/protocol";
import { detectCapabilities } from "./capabilities";
import { makeControlPlaneHandler } from "./control-plane";
import { loadOrCreateMachineId } from "./machine-id";
import { registerWithCluster, startHeartbeatLoop } from "./registration";
import {
  createDesktopSandboxProvider,
  type SpawnResult,
} from "./user-desktop-provider";
import { readSession } from "./session";
import { computeLinkSubDomain, openTunnel } from "./tunnel";

export interface StartLinkDaemonOptions {
  port: number;
  noTunnel: boolean;
  clusterBaseUrl: string;
  dataDir: string;
}

export interface LinkDaemonHandle {
  /** Resolves with the daemon's exit code when it shuts down. */
  stopped: Promise<number>;
  /** Trigger graceful shutdown (equivalent to receiving SIGTERM). */
  stop: () => Promise<void>;
}

export async function startLinkDaemon(
  opts: StartLinkDaemonOptions,
): Promise<LinkDaemonHandle> {
  const session = await readSession(opts.dataDir);
  if (!session) {
    throw new Error(
      "No session found. Run `deco auth login` first, then re-run `deco link`.",
    );
  }

  const machineId = await loadOrCreateMachineId(opts.dataDir);
  const cliVersion = process.env.npm_package_version ?? "0.0.0";
  const hostname = osHostname() || undefined;

  let tunnel: {
    publicUrl: string;
    close: () => void;
    closed?: Promise<void>;
  } | null = null;
  let tunnelBaseUrl: string;
  if (opts.noTunnel) {
    tunnelBaseUrl = `http://localhost:${opts.port}`;
    console.log(`Tunnel disabled. Advertising ${tunnelBaseUrl} to cluster.`);
  } else {
    const subDomain = computeLinkSubDomain(session.user.sub);
    tunnel = await openTunnel({
      subDomain,
      localAddr: `http://127.0.0.1:${opts.port}`,
    });
    tunnelBaseUrl = tunnel.publicUrl;
    console.log(`Tunnel open: ${tunnelBaseUrl}`);
  }

  // Register first — the cluster mints the linkSecret we then plumb
  // through to every spawned sandbox daemon (DAEMON_LINK_SECRET env),
  // so the cluster's HMAC-signed dispatch requests verify on arrival.
  const { linkSecret } = await registerWithCluster({
    clusterBaseUrl: opts.clusterBaseUrl,
    sessionToken: session.accessToken,
    machineId,
    hostname,
    cliVersion,
    capabilities: await detectCapabilities(),
    tunnelUrl: opts.noTunnel ? tunnelBaseUrl : undefined,
  });
  console.log(
    `Linked. Protocol v${LINK_PROTOCOL_VERSION}. machineId=${machineId}${
      hostname ? ` hostname=${hostname}` : ""
    }`,
  );

  // Per-port DAEMON_TOKEN registry so postSandboxConfig can authenticate
  // against the spawned daemon's non-dispatch routes.
  const perPortTokens = new Map<number, string>();

  const innerSpawn = createDefaultDaemonSpawn(opts.dataDir);
  const spawnSandboxDaemon = ({
    workdir,
    port,
  }: {
    workdir: string;
    handle: string;
    port: number;
  }): Promise<SpawnResult> => {
    const token = randomBytes(24).toString("hex");
    const bootId = randomUUID();
    const env: Record<string, string> = {
      DAEMON_TOKEN: token,
      DAEMON_BOOT_ID: bootId,
      APP_ROOT: workdir,
      PROXY_PORT: String(port),
      DAEMON_LINK_SECRET: linkSecret,
    };
    perPortTokens.set(port, token);
    return innerSpawn({ workdir, env, daemonPort: port }).then((proc) => ({
      port,
      kill: (sig) => proc.kill(sig),
      exited: proc.exited.then(() => undefined),
    }));
  };

  const postSandboxConfig = async (
    port: number,
    devPort: number,
    config: {
      repo?: {
        cloneUrl: string;
        branch?: string;
        userName?: string;
        userEmail?: string;
      };
    },
  ): Promise<void> => {
    const token = perPortTokens.get(port);
    if (!token) {
      throw new Error(`no daemon token for port ${port}`);
    }
    const daemonUrl = `http://127.0.0.1:${port}`;
    // The daemon's TenantConfig wire shape is `{ git, application }`.
    // packageManager + runtime are auto-detected by the orchestrator from
    // the lockfile post-clone, so we leave them out. `application.port`
    // is the port the dev script binds to — without it, frameworks
    // default to 3000 and collide with the cluster's own dev server.
    // Allocating a fresh ephemeral per sandbox keeps multiple parallel
    // sandboxes from also colliding with each other.
    const payload: Record<string, unknown> = {
      application: { port: devPort },
    };
    if (config.repo) {
      payload.git = {
        repository: {
          cloneUrl: config.repo.cloneUrl,
          branch: config.repo.branch,
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
    await daemonPostConfig(daemonUrl, token, payload);
  };

  const waitForSandboxHealth = async (port: number): Promise<void> => {
    await waitForDaemonReady(`http://127.0.0.1:${port}`);
  };

  const provider = createDesktopSandboxProvider({
    dataDir: opts.dataDir,
    spawnDaemon: spawnSandboxDaemon,
    postConfig: postSandboxConfig,
    waitForHealth: waitForSandboxHealth,
    openDaemonTunnel: async ({ subDomain, localAddr }) => {
      if (opts.noTunnel) return null;
      return openTunnel({ subDomain, localAddr });
    },
    maxSandboxes: 20,
  });

  // TTL'd nonce cache for HMAC replay protection.
  const nonceTtlMs = 60_000;
  const nonces = new Map<string, number>();
  const sweepNonces = () => {
    const now = Date.now();
    for (const [n, exp] of nonces) if (exp <= now) nonces.delete(n);
  };
  const sweepInterval = setInterval(sweepNonces, nonceTtlMs);
  sweepInterval.unref?.();

  const handler = makeControlPlaneHandler({
    provider,
    linkSecret,
    seenNonce: (n) => {
      const exp = nonces.get(n);
      return exp != null && exp > Date.now();
    },
    recordNonce: (n) => {
      nonces.set(n, Date.now() + nonceTtlMs);
    },
  });

  const stopHeartbeat = startHeartbeatLoop({
    clusterBaseUrl: opts.clusterBaseUrl,
    linkSecret,
    userSub: session.user.sub,
  });

  const server = Bun.serve({
    port: opts.port,
    fetch: handler,
  });
  console.log(`Listening on http://127.0.0.1:${server.port}`);

  // ── Graceful shutdown ─────────────────────────────────────────────
  let resolveStopped!: (code: number) => void;
  const stopped = new Promise<number>((resolve) => {
    resolveStopped = resolve;
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down…");
    stopHeartbeat();
    clearInterval(sweepInterval);
    try {
      await fetch(`${opts.clusterBaseUrl}/api/links/me`, {
        method: "DELETE",
        headers: {
          "x-link-secret": linkSecret,
          "x-mesh-user-sub": session.user.sub,
        },
      });
    } catch {
      // best-effort
    }
    try {
      await provider.shutdown();
    } catch {
      // ignore
    }
    try {
      tunnel?.close();
    } catch {
      // ignore
    }
    try {
      server.stop(true);
    } catch {
      // ignore
    }
    resolveStopped(0);
  };

  const onSigInt = () => void shutdown();
  const onSigTerm = () => void shutdown();
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  void stopped.then(() => {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  });

  if (tunnel) {
    // If the Warp tunnel drops, the link is effectively offline — exit
    // so the process supervisor (or the user's `&&` chain) can decide
    // what to do next. The cluster will mark us offline within ~30s
    // when heartbeats stop arriving.
    void Promise.resolve(tunnel.closed).then(() => {
      if (shuttingDown) return;
      console.error("Tunnel closed unexpectedly; exiting.");
      void shutdown();
    });
  }

  return { stopped, stop: shutdown };
}
