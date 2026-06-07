/**
 * `deco link` — start the desktop-side link daemon.
 *
 * Uses a pure-pull transport: long-polls `/api/:org/links/work` for
 * dispatched sandbox requests, `/links/control` for cluster control frames,
 * and `/links/proxy` for reverse-proxy traffic. Presence is maintained via a
 * 60 s NATS-KV TTL re-armed on every poll. Also runs a local ingress on
 * `--port` for `<handle>.localhost` sandbox previews.
 *
 * Auth: calls `ensureSession` first (with normal console output so the OAuth
 * login flow is visible). With a TTY (and no `--no-tui`), renders the Ink
 * task-manager view; otherwise streams plain `console.log` output.
 */
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "../lib/ensure-session";
import { startLinkDaemon, type LinkDaemonMonitor } from "../../link-daemon";
import { formatLogLine } from "../format-log-line";

export interface LinkCommandOptions {
  port?: number;
  clusterBaseUrl?: string;
  dataDir?: string;
  /** Render the Ink task-manager view. False → plain console.log output. */
  tui?: boolean;
  /** Version string for the banner (plain mode). */
  version?: string;
  /**
   * Print the ASCII banner in plain mode. Default true. The managed daemon
   * spawned by `ensureLink` (dev / npx `--local-sandbox-provider`) sets this
   * to false so it doesn't render a second banner inside the parent
   * `dev`/`serve` TUI.
   */
  banner?: boolean;
  /**
   * Organization slug the daemon links against. The pull transport is
   * org-scoped (`/api/:org/links/*`), so the daemon needs to know which org.
   * Resolution order: this option → `DECO_ORG_SLUG` env → auto-resolve from
   * the cluster (the user's single org; ambiguous if they belong to several).
   */
  orgSlug?: string;
}

/**
 * Redirect the parent process's console away from the terminal so it can't
 * corrupt the Ink render. When `logFd` is given, `log`/`warn`/`error` lines
 * are appended to the `deco link` log file; `error` is additionally surfaced
 * in the TUI footer via `onError`. `--no-tui` is the escape hatch for live
 * terminal logs (it never installs this interception).
 */
function interceptLinkConsole(
  onError: (msg: string) => void,
  logFd?: number,
): () => void {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const tee = (args: unknown[]): void => {
    if (logFd === undefined) return;
    try {
      writeSync(logFd, `${formatLogLine(args)}\n`);
    } catch {
      // Log file unavailable — never let logging break the daemon.
    }
  };
  console.log = (...args: unknown[]) => tee(args);
  console.warn = (...args: unknown[]) => tee(args);
  console.error = (...args: unknown[]) => {
    tee(args);
    onError(formatLogLine(args));
  };
  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
}

/**
 * Fails loudly when the studio rejects the session token (401/403) instead of
 * letting the daemon's WS reconnect loop retry an invalid token indefinitely
 * (the WS handshake 401 surfaces only as an abnormal 1006 close, which the
 * reconnect policy treats as retryable). Network/other errors are ignored —
 * the connection attempt will surface those itself.
 */
async function assertStudioAcceptsToken(
  clusterBaseUrl: string,
  token: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${clusterBaseUrl}/api/links/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return; // network / timeout — let the daemon try and report
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Authentication rejected by ${clusterBaseUrl} — the session token was not accepted. ` +
        `Run \`deco auth login --target ${clusterBaseUrl}\` and try again.`,
    );
  }
}

/**
 * Resolve the organization slug the daemon links against. The pull transport
 * routes are org-scoped (`/api/:org/links/*`), so a slug is required (the old
 * WS endpoint `/api/links/connect` was unscoped, so this used to be implicit).
 * Resolution: explicit `--org` → `DECO_ORG_SLUG` → the user's single org
 * (listed from the cluster with the session token). Throws a clear, actionable
 * error if it can't be determined.
 */
async function resolveOrgSlug(
  clusterBaseUrl: string,
  token: string,
  explicit: string | undefined,
): Promise<string> {
  const fromOpt = explicit?.trim();
  if (fromOpt) return fromOpt;
  const fromEnv = process.env.DECO_ORG_SLUG?.trim();
  if (fromEnv) return fromEnv;
  let res: Response;
  try {
    res = await fetch(`${clusterBaseUrl}/api/auth/organization/list`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(
      `Could not resolve your organization from ${clusterBaseUrl} ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Pass --org <slug> or set DECO_ORG_SLUG.`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Could not list organizations on ${clusterBaseUrl} (HTTP ${res.status}). ` +
        `Pass --org <slug> or set DECO_ORG_SLUG.`,
    );
  }
  const orgs = (await res.json().catch(() => null)) as Array<{
    slug?: string;
  }> | null;
  const slugs = Array.isArray(orgs)
    ? orgs.map((o) => o?.slug).filter((s): s is string => Boolean(s))
    : [];
  if (slugs.length === 0) {
    throw new Error(
      `No organization found for your account on ${clusterBaseUrl}. ` +
        `Create one first, then re-run, or pass --org <slug>.`,
    );
  }
  if (slugs.length > 1) {
    throw new Error(
      `You belong to multiple organizations (${slugs.join(", ")}). ` +
        `Pass --org <slug> or set DECO_ORG_SLUG to choose which to link.`,
    );
  }
  return slugs[0]!;
}

export async function runLinkCommand(
  opts: LinkCommandOptions = {},
): Promise<number> {
  const port = opts.port ?? 5174;
  const dataDir =
    opts.dataDir ??
    process.env.DATA_DIR ??
    process.env.DECOCMS_HOME ??
    join(homedir(), "deco");
  const clusterBaseUrl =
    opts.clusterBaseUrl ??
    process.env.MESH_CLUSTER_URL ??
    "https://studio.decocms.com";

  let restoreConsole: (() => void) | undefined;
  let logFd: number | undefined;
  try {
    // Login flow (may open a browser / prompt) runs with normal console.
    // Auth targets the same studio we link against.
    const session = await ensureSession({
      dataDir,
      intent: "Link",
      target: clusterBaseUrl,
    });

    // Preflight (interactive / standalone only): confirm the studio accepts
    // this token before connecting. The managed daemon (dev) skips it — its
    // failures surface in the parent dev logs, and it authenticates with a
    // bootstrapped API key rather than a logged-in session.
    if (process.env.DECOCMS_LINK_MANAGED !== "1") {
      await assertStudioAcceptsToken(clusterBaseUrl, session.accessToken);
    }

    // The pull transport is org-scoped (`/api/:org/links/*`) — resolve the org
    // slug before starting the daemon (else it exits with "requires an org
    // slug"). Surfaces a clear error here, before any TUI render.
    const orgSlug = await resolveOrgSlug(
      clusterBaseUrl,
      session.accessToken,
      opts.orgSlug,
    );

    let monitor: LinkDaemonMonitor | undefined;

    if (opts.tui) {
      const { render } = await import("ink");
      const { createElement } = await import("react");
      const { LinkApp } = await import("../link-app");
      const {
        pushSandboxEvent,
        setCluster,
        setClusterUrl,
        setDaemonError,
        setIngress,
        setLogPath,
        setMachine,
      } = await import("../link-store");

      // Combined log file: both the parent's intercepted console output and
      // every spawned sandbox daemon's stdout/stderr land here, keeping the
      // Ink canvas clean. Append mode so it survives across restarts.
      mkdirSync(dataDir, { recursive: true });
      const logPath = join(dataDir, "link.log");
      logFd = openSync(logPath, "a");
      setLogPath(logPath);

      setClusterUrl(clusterBaseUrl);
      setCluster("connecting");
      monitor = {
        onEvent: (e) => pushSandboxEvent(e),
        onIngress: (p) => setIngress(p, `http://127.0.0.1:${p}`),
        onCluster: (s) => setCluster(s),
        onMachine: (label) => setMachine(label),
      };
      restoreConsole = interceptLinkConsole(setDaemonError, logFd);
      render(createElement(LinkApp), { patchConsole: false });
    } else if (opts.banner !== false) {
      const { printBanner } = await import("../banner-art");
      printBanner(opts.version ?? "0.0.0");
    }

    const handle = await startLinkDaemon({
      port,
      clusterBaseUrl,
      dataDir,
      session,
      monitor,
      logFd,
      orgSlug,
    });
    return await handle.stopped;
  } catch (err) {
    // Restore BEFORE printing so a fatal error is visible on real stderr,
    // not swallowed into the TUI footer.
    restoreConsole?.();
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    // Backstop: console must never leak patched, regardless of exit path.
    restoreConsole?.();
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch {
        // already closed
      }
    }
  }
}
