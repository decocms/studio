/**
 * TCP-level reachability probe for loopback addresses, shared by the HTTP
 * and WebSocket proxies.
 *
 * Inside the sandbox the dev server may bind IPv4 only (127.0.0.1, classic
 * Node default) or IPv6 only ([::1], what `Bun.serve`/Vite-on-Bun pick on a
 * dual-stack system). Bun resolves `localhost` to a single address — the
 * wrong one half the time — so we probe both before opening the real
 * connection. Probing first means a mid-flight failure on the chosen
 * address never silently retries on the other one, which would re-execute
 * non-idempotent requests on HTTP and re-do the WS handshake on WS.
 *
 * ECONNREFUSED on a closed loopback port comes back instantly, so the probe
 * adds ~1ms in the IPv4-only case and zero in the IPv6 case.
 */
import { connect } from "node:net";

const PROBE_TIMEOUT_MS = 500;

export type LoopbackHost = "::1" | "127.0.0.1";

function canConnect(host: LoopbackHost, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

/**
 * Returns the loopback address currently accepting connections on `port`,
 * preferring IPv6. `null` when neither responds.
 */
export async function pickLoopback(port: number): Promise<LoopbackHost | null> {
  if (await canConnect("::1", port)) return "::1";
  if (await canConnect("127.0.0.1", port)) return "127.0.0.1";
  return null;
}

/** Wraps the host for use in a URL (`[::1]` vs `127.0.0.1`). */
export function bracketHost(host: LoopbackHost): string {
  return host === "::1" ? "[::1]" : host;
}
