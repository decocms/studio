import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { computeAppDomain } from "../lib/app-domain";
import { copyToClipboard } from "../lib/clipboard";
import { waitForPort } from "../lib/port-wait";
import { readSession, type Session } from "../lib/session";
import { loginCommand } from "./auth/login";

export interface TunnelHandle {
  closed: Promise<void>;
  close: () => void;
  // TODO: surface auth failure separately so the caller can show the
  // "session may be expired" hint described in the spec.
}

export type TunnelOpener = (params: {
  domain: string;
  localAddr: string;
  apiKey: string;
  server: string;
}) => Promise<TunnelHandle>;

/** Minimal spawn signature used by linkCommand — compatible with node:child_process spawn. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; shell: boolean; env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface LinkOptions {
  cwd: string;
  dataDir: string;
  port: number;
  env: string;
  runCommand: string[];
  /** Injectable: defaults to defaultTunnelOpener (dynamic import of @deco-cx/warp-node). */
  tunnelOpener?: TunnelOpener;
  /** Injectable: defaults to waitForPort. */
  portWaiter?: (port: number) => Promise<string>;
  /** Injectable: defaults to copyToClipboard. */
  copyClipboard?: (text: string) => Promise<boolean>;
  /** Called when no session is present. Returns the new session or null on failure. */
  ensureSession?: () => Promise<Session | null>;
  /** Injectable: defaults to node:child_process spawn. */
  spawn?: SpawnFn;
  /** Reconnect delay after a tunnel disconnect (default 500ms, matches legacy). */
  reconnectDelayMs?: number;
}

export interface LinkRunResult {
  exit: Promise<number>;
  cancel: () => Promise<void>;
}

export function linkCommand(options: LinkOptions): LinkRunResult {
  let resolveExit!: (n: number) => void;
  const exit = new Promise<number>((r) => {
    resolveExit = r;
  });

  let child: ChildProcess | undefined;
  let tunnel: TunnelHandle | undefined;
  let cancelled = false;

  const cancel = async () => {
    cancelled = true;
    try {
      child?.kill("SIGTERM");
    } catch {}
    try {
      tunnel?.close();
    } catch {}
    resolveExit(0);
  };

  void (async () => {
    try {
      let session = await readSession(options.dataDir);
      if (!session) {
        const ensure =
          options.ensureSession ?? defaultEnsureSession(options.dataDir);
        console.log("No session found — opening login...");
        session = await ensure();
        if (!session) {
          console.error("Login failed; cannot open tunnel.");
          resolveExit(1);
          return;
        }
      }

      const appName = await readPackageName(options.cwd);
      if (!appName) {
        console.error(
          "Could not read `name` from package.json. Run `decocms link` from a project directory.",
        );
        resolveExit(1);
        return;
      }

      const domain = computeAppDomain(session.user.sub, appName);
      const publicUrl = `https://${domain}`;

      const spawnImpl: SpawnFn = options.spawn ?? nodeSpawn;
      if (options.runCommand.length > 0) {
        const [cmd, ...args] = options.runCommand;
        if (!cmd) {
          console.error("runCommand must not be empty");
          resolveExit(1);
          return;
        }
        console.log(`Starting: ${cmd} ${args.join(" ")}`);
        const spawned = spawnImpl(cmd, args, {
          stdio: "inherit",
          shell: true,
          env: { ...process.env, [options.env]: publicUrl },
        });
        child = spawned;
        spawned.on("exit", (code) => {
          if (cancelled) return;
          cancelled = true;
          try {
            tunnel?.close();
          } catch {}
          resolveExit(code ?? 0);
        });
      } else {
        console.log(
          `Tunnel will connect to existing service on port ${options.port}.`,
        );
      }

      const wait = options.portWaiter ?? ((p: number) => waitForPort(p));
      const opener = options.tunnelOpener ?? defaultTunnelOpener;
      const copy = options.copyClipboard ?? copyToClipboard;
      const reconnectDelay = options.reconnectDelayMs ?? 500;

      // Loop: open tunnel, wait for it to close, reconnect after a small delay.
      // Matches legacy behavior — exits only when the user cancels.
      let firstOpen = true;
      while (!cancelled) {
        const host = await wait(options.port);
        try {
          tunnel = await opener({
            domain,
            localAddr: `http://${host}:${options.port}`,
            apiKey: session.accessToken,
            server: `wss://${domain}`,
          });
        } catch (err) {
          console.error(
            `Tunnel connect failed, retrying: ${err instanceof Error ? err.message : String(err)}`,
          );
          await sleep(reconnectDelay);
          continue;
        }

        if (firstOpen) {
          console.log(`Tunnel open: ${publicUrl}`);
          if (await copy(publicUrl)) {
            console.log("(URL copied to clipboard)");
          }
          firstOpen = false;
        } else {
          console.log("Tunnel reconnected.");
        }

        await tunnel.closed;
        if (cancelled) break;
        console.log("Tunnel closed, reconnecting...");
        await sleep(reconnectDelay);
      }

      if (!cancelled) resolveExit(0);
    } catch (err) {
      console.error(
        `Link failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      resolveExit(1);
    }
  })();

  return { exit, cancel };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPackageName(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0
      ? parsed.name
      : null;
  } catch {
    return null;
  }
}

function defaultEnsureSession(dataDir: string): () => Promise<Session | null> {
  return async () => {
    const code = await loginCommand({ dataDir });
    if (code !== 0) return null;
    return readSession(dataDir);
  };
}

// The Warp tunnel server still expects the legacy shared key — it does not
// yet verify OAuth bearer tokens. Until that lands, fall back to this
// hardcoded value (overridable via DECO_TUNNEL_SERVER_TOKEN) so `link`
// works end-to-end. The session's OAuth access token from `params.apiKey`
// is intentionally ignored here for now; we keep storing it on the
// session so we can flip the source back in one line once Warp is ready.
const LEGACY_TUNNEL_TOKEN = "c309424a-2dc4-46fe-bfc7-a7c10df59477";

// If `tunnel.registered` doesn't resolve within this window, the Warp
// server most likely silently rejected the auth. Surface that as an
// error instead of hanging indefinitely.
const REGISTRATION_TIMEOUT_MS = 15_000;

const defaultTunnelOpener: TunnelOpener = async (params) => {
  const { connect } = await import("@deco-cx/warp-node");
  const tunnel = await connect({
    domain: params.domain,
    localAddr: params.localAddr,
    server: params.server,
    apiKey: process.env.DECO_TUNNEL_SERVER_TOKEN ?? LEGACY_TUNNEL_TOKEN,
  });
  await Promise.race([
    tunnel.registered,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Tunnel registration timed out after ${REGISTRATION_TIMEOUT_MS / 1000}s — Warp server may have rejected the auth. Try upgrading the CLI.`,
          ),
        );
      }, REGISTRATION_TIMEOUT_MS);
    }),
  ]);
  return {
    // Connected.closed resolves with Error | undefined; we discard the value
    // to satisfy TunnelHandle.closed: Promise<void>.
    closed: tunnel.closed.then(() => undefined),
    close: () => {
      // @deco-cx/warp-node Connected has no close() method; the connection
      // closes on its own when the server drops it.
    },
  };
};
