/**
 * Warp tunnel client. Wraps `@deco-cx/warp-node` so the rest of the
 * link daemon stays free of the legacy import. `openTunnel` returns the
 * public URL the tunnel resolved to and a `closed` promise the caller
 * can await for reconnect logic.
 *
 * The Warp server still uses a legacy shared key; the user's OAuth
 * bearer is intentionally NOT sent yet. Once Warp accepts OAuth tokens
 * we can swap the source in one place.
 */

export interface TunnelHandle {
  /** The `https://<sub>.deco.host` URL the tunnel listens at. */
  publicUrl: string;
  /** Resolves when the tunnel disconnects. */
  closed: Promise<void>;
  /** Best-effort close (Warp's Connected has no close() — server-side close). */
  close: () => void;
}

export interface OpenTunnelInput {
  /** Stable per-user-per-app subdomain (see computeAppDomain). */
  subDomain: string;
  /** Local target the tunnel forwards to (e.g. `http://127.0.0.1:5174`). */
  localAddr: string;
  /** Cluster's tunnel server (defaults to `wss://<subDomain>`). */
  server?: string;
  /** Override the Warp shared key (defaults to env / hardcoded legacy). */
  apiKey?: string;
}

/** Warp tunnel server pre-OAuth shared key — same value `apps/mesh` used. */
const LEGACY_TUNNEL_TOKEN = "c309424a-2dc4-46fe-bfc7-a7c10df59477";

/** If `tunnel.registered` doesn't resolve, treat as silent auth rejection. */
const REGISTRATION_TIMEOUT_MS = 15_000;

export async function openTunnel(
  input: OpenTunnelInput,
): Promise<TunnelHandle> {
  const { connect } = await import("@deco-cx/warp-node");
  const tunnel = await connect({
    domain: input.subDomain,
    localAddr: input.localAddr,
    server: input.server ?? `wss://${input.subDomain}`,
    apiKey:
      input.apiKey ??
      process.env.DECO_TUNNEL_SERVER_TOKEN ??
      LEGACY_TUNNEL_TOKEN,
  });
  await Promise.race([
    tunnel.registered,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Tunnel registration timed out after ${
              REGISTRATION_TIMEOUT_MS / 1000
            }s — Warp server may have rejected the auth. Try upgrading the CLI.`,
          ),
        );
      }, REGISTRATION_TIMEOUT_MS);
    }),
  ]);
  return {
    publicUrl: `https://${input.subDomain}`,
    closed: tunnel.closed.then(() => undefined),
    close: () => {
      // @deco-cx/warp-node Connected has no close() method; the
      // connection closes on its own when the server drops it.
    },
  };
}

/**
 * Stable subdomain the cluster expects for the link daemon. Must match
 * the cluster's `expectedTunnelDomain(userSub)` in
 * `apps/mesh/src/links/routes.ts` — both sides derive the host from the
 * authenticated userSub independently.
 *
 * userSub is lowercased because hostnames are case-insensitive (RFC 3986
 * §3.2.2) but Better Auth subs are case-sensitive nanoids. WHATWG URL
 * parsing lowercases the host on the wire, so a mixed-case sub
 * registered as `domain` in the Warp protocol won't match the lowercase
 * Host header on incoming HTTP requests — the deco.host DO's
 * `hostToClientId` map misses and returns 503 "No registration for
 * domain". Lowercase here keeps the application-layer registration in
 * sync with what the transport actually sees.
 */
export function computeLinkSubDomain(userSub: string): string {
  return `link-${userSub.toLowerCase()}.deco.host`;
}
