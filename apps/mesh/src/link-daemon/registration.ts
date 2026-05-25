/**
 * Talks to the cluster's `/api/links/*` HTTP surface:
 *
 *   POST  /api/links              — register (session-authed). Returns
 *                                   the raw `linkSecret` exactly once.
 *   POST  /api/links/heartbeat    — refresh TTL (authed via X-Link-Secret
 *                                   header against the linkSecret).
 *   DELETE /api/links/me          — graceful shutdown (session-authed).
 *
 * Heartbeat and graceful-shutdown carry the linkSecret in `X-Link-Secret`
 * rather than `Authorization: Bearer …` so it never enters Better Auth's
 * API-key validation path on the cluster (which would log every tick as
 * an INVALID_API_KEY false positive).
 *
 * Registration errors carry actionable hints — 409 means another machine
 * is registered for the account, 426 means this CLI is too old for the
 * cluster's protocolVersion. Both surface as user-readable Error messages.
 */

import {
  LINK_PROTOCOL_VERSION,
  type Capability,
  type RegistrationPayload,
  type RegistrationResponse,
} from "@/links/protocol";

export interface RegistrationInput {
  clusterBaseUrl: string;
  /** OAuth access token from the user's CLI session. */
  sessionToken: string;
  machineId: string;
  /** OS hostname, used as a human-readable display label in the cluster UI. */
  hostname?: string;
  cliVersion: string;
  capabilities: Capability[];
  /**
   * Only honored when the cluster has `MESH_ALLOW_LOCALHOST_LINKS=1`.
   * In production the cluster derives the expected Warp domain from
   * the user's sub and ignores any value sent here.
   */
  tunnelUrl?: string;
}

export async function registerWithCluster(
  input: RegistrationInput,
): Promise<RegistrationResponse> {
  const body: RegistrationPayload = {
    machineId: input.machineId,
    cliVersion: input.cliVersion,
    protocolVersion: LINK_PROTOCOL_VERSION,
    capabilities: input.capabilities,
    ...(input.hostname ? { hostname: input.hostname } : {}),
    ...(input.tunnelUrl ? { tunnelUrl: input.tunnelUrl } : {}),
  };
  const res = await fetch(`${input.clusterBaseUrl}/api/links`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.sessionToken}`,
    },
  });
  if (res.status === 409) {
    const data = (await res.json().catch(() => ({}))) as {
      activeMachineId?: string;
    };
    throw new Error(
      `Another machine (${data.activeMachineId ?? "unknown"}) is already linked for this account. ` +
        `Stop that one first, or wait ~30s for its registration to expire.`,
    );
  }
  if (res.status === 426) {
    const data = (await res.json().catch(() => ({}))) as {
      installHint?: string;
    };
    throw new Error(
      `Protocol too old (link v${LINK_PROTOCOL_VERSION}). ${data.installHint ?? "Upgrade the decocms CLI."}`,
    );
  }
  if (res.status === 401) {
    throw new Error(
      "Cluster rejected the session token (401). Re-run `decocms auth login` and try again.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Registration failed: HTTP ${res.status}${text ? ` — ${text}` : ""}`,
    );
  }
  const parsed = (await res.json()) as RegistrationResponse;
  if (!parsed || typeof parsed.linkSecret !== "string") {
    throw new Error("Registration response missing linkSecret");
  }
  return parsed;
}

export interface HeartbeatInput {
  clusterBaseUrl: string;
  /** Raw link secret returned at registration. The cluster compares the
   * presented bearer directly against the stored raw value (HMAC signing
   * is symmetric — see schemas.ts JSDoc on linkSecret). */
  linkSecret: string;
  /** userSub the cluster keys the link entry by. Sent in
   *  X-Mesh-User-Sub so the route can look up the entry without an active
   *  Better Auth session. */
  userSub: string;
  intervalMs?: number;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to setTimeout. */
  schedule?: (cb: () => void, ms: number) => unknown;
  /** Logger override (silences warnings in tests). */
  onError?: (err: unknown) => void;
}

export function startHeartbeatLoop(input: HeartbeatInput): () => void {
  const interval = input.intervalMs ?? 10_000;
  const fetcher = input.fetchImpl ?? fetch;
  const schedule = input.schedule ?? setTimeout;
  const onError =
    input.onError ??
    ((err: unknown) =>
      console.warn(
        `heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
      ));

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const res = await fetcher(`${input.clusterBaseUrl}/api/links/heartbeat`, {
        method: "POST",
        headers: {
          "x-link-secret": input.linkSecret,
          "x-mesh-user-sub": input.userSub,
        },
      });
      if (!res.ok && res.status !== 204) {
        onError(new Error(`heartbeat HTTP ${res.status}`));
      }
    } catch (err) {
      onError(err);
    }
    if (!stopped) schedule(() => void tick(), interval);
  };
  schedule(() => void tick(), interval);
  return () => {
    stopped = true;
  };
}
