/**
 * `deco link` — start the desktop-side link daemon.
 *
 * Opens a WebSocket to `<MESH_CLUSTER_URL>/api/links/connect` and runs a
 * local ingress on `--port` for `<handle>.localhost` sandbox previews.
 *
 * Auth: calls `ensureSession` first (with normal console output so the OAuth
 * login flow is visible). With a TTY (and no `--no-tui`), renders the Ink
 * task-manager view; otherwise streams plain `console.log` output.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "../lib/ensure-session";
import { startLinkDaemon, type LinkDaemonMonitor } from "../../link-daemon";

export interface LinkCommandOptions {
  port?: number;
  clusterBaseUrl?: string;
  dataDir?: string;
  /** Render the Ink task-manager view. False → plain console.log output. */
  tui?: boolean;
  /** Version string for the banner (plain mode). */
  version?: string;
}

/**
 * Swallow daemon stdout so it can't corrupt the Ink render; route errors to
 * the TUI footer via `onError`. `--no-tui` is the escape hatch for full logs.
 */
function interceptLinkConsole(onError: (msg: string) => void): () => void {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = (...args: unknown[]) => {
    onError(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
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
  try {
    // Login flow (may open a browser / prompt) runs with normal console.
    const session = await ensureSession({ dataDir, intent: "Link" });

    let monitor: LinkDaemonMonitor | undefined;

    if (opts.tui) {
      const { render } = await import("ink");
      const { createElement } = await import("react");
      const { LinkApp } = await import("../link-app");
      const {
        pushSandboxEvent,
        setCluster,
        setDaemonError,
        setIngress,
        setMachine,
      } = await import("../link-store");

      setCluster("connecting");
      monitor = {
        onEvent: (e) => pushSandboxEvent(e),
        onIngress: (p) => setIngress(p, `http://127.0.0.1:${p}`),
        onCluster: (s) => setCluster(s),
        onMachine: (label) => setMachine(label),
      };
      restoreConsole = interceptLinkConsole(setDaemonError);
      render(createElement(LinkApp), { patchConsole: false });
    } else {
      const { printBanner } = await import("../banner-art");
      printBanner(opts.version ?? "0.0.0");
    }

    const handle = await startLinkDaemon({
      port,
      clusterBaseUrl,
      dataDir,
      session,
      monitor,
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
  }
}
