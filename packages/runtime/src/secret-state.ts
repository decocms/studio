import { base64url, decodeJwt } from "jose";

const DEFAULT_TRUSTED_STUDIO_URLS = "https://studio.decocms.com";
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 500;

interface CachedState {
  state: Record<string, unknown>;
  proofKey: string;
  expiresAt: number;
}

const cache = new Map<string, CachedState>();

/** The request's state could not be read from Studio; `status` is the response to give. */
export class StateUnavailableError extends Error {
  constructor(
    readonly status: 401 | 502,
    message: string,
  ) {
    super(message);
  }
}

async function proofMatches(
  proofKey: string,
  message: string,
  proof: string,
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(proofKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      new Uint8Array(base64url.decode(proof)),
      encoder.encode(message),
    );
  } catch {
    return false;
  }
}

/**
 * The full configuration state for a token whose secrets Studio left out
 * (`metadata.stateHash`), read from Studio's vault with the token itself.
 * Studio verifies the token to answer, so a forged one gets no state. The
 * answer is kept in memory and reused for later tokens that carry a valid
 * proof under the key Studio returned with it. Null when the token carries
 * its whole state, as tokens from older Studio versions do.
 *
 * `STUDIO_TRUSTED_URLS` (comma-separated origins) names the Studio instances
 * this MCP may ask; the token's own URL is not trusted until it is on it.
 */
export async function resolveSecretState(
  token: string,
  trustedStudioUrls: string | undefined,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Record<string, unknown> | null> {
  let payload: ReturnType<typeof decodeJwt>;
  try {
    payload = decodeJwt(token);
  } catch {
    return null;
  }
  const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
  const { stateHash, stateProof, connectionId, organizationSlug } = metadata;
  if (stateHash === undefined) return null;

  const studioUrl = metadata.studioUrl ?? metadata.meshUrl;
  if (
    typeof stateHash !== "string" ||
    typeof stateProof !== "string" ||
    typeof connectionId !== "string" ||
    typeof organizationSlug !== "string" ||
    typeof studioUrl !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new StateUnavailableError(401, "Malformed studio token");
  }

  const trusted = (trustedStudioUrls || DEFAULT_TRUSTED_STUDIO_URLS)
    .split(",")
    .map((url) => url.trim().replace(/\/+$/, ""));
  let origin: string;
  try {
    origin = new URL(studioUrl).origin;
  } catch {
    throw new StateUnavailableError(401, "Malformed studio token");
  }
  if (!trusted.includes(origin)) {
    throw new StateUnavailableError(401, "Untrusted Studio URL");
  }

  const now = Date.now();
  const cacheKey = `${origin}|${connectionId}|${stateHash}`;
  const cached = cache.get(cacheKey);
  if (
    cached &&
    cached.expiresAt > now &&
    payload.exp * 1000 > now &&
    (await proofMatches(
      cached.proofKey,
      `${stateHash}.${payload.exp}`,
      stateProof,
    ))
  ) {
    return cached.state;
  }

  let response: Response;
  try {
    response = await fetchImpl(
      `${origin}/api/${encodeURIComponent(organizationSlug)}/vault/connections/${encodeURIComponent(connectionId)}/configuration`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    throw new StateUnavailableError(502, "Studio is unreachable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new StateUnavailableError(401, "Studio rejected the token");
  }
  const body = response.ok
    ? ((await response.json().catch(() => null)) as {
        state?: unknown;
        proofKey?: unknown;
        stateHash?: unknown;
      } | null)
    : null;
  if (
    !body ||
    typeof body.state !== "object" ||
    body.state === null ||
    Array.isArray(body.state) ||
    typeof body.proofKey !== "string"
  ) {
    throw new StateUnavailableError(502, "Studio returned no configuration");
  }

  const state = body.state as Record<string, unknown>;
  // Studio tells an MCP about a new configuration before it saves it, so the
  // vault can still hold the previous one: use it, but do not keep it.
  if (body.stateHash !== stateHash) return state;
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, {
    state,
    proofKey: body.proofKey,
    expiresAt: now + CACHE_TTL_MS,
  });
  return state;
}
