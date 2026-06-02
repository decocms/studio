/**
 * Derive the SSRF allowlist the user-desktop sandbox daemon must use to fetch
 * offloaded `messagesRef.url` payloads.
 *
 * THE TRUST BOUNDARY: the daemon runs on the user's machine and fails CLOSED
 * (empty allowlist) by default. The only trusted source of the object-storage
 * host is the cluster's own S3 config — so the cluster derives the host here
 * and pushes it down the control channel at sandbox-spawn time. The host is
 * NEVER taken from a request frame.
 *
 * We derive the host by minting a real presigned GET URL with the same bound
 * storage the offload `put` uses and reading its `hostname`. This guarantees
 * the allowlist matches EXACTLY what the offload path mints — including the
 * virtual-hosted-style `<bucket>.<host>` case, which a naive parse of
 * `S3_ENDPOINT` would miss.
 */

import { getSettings } from "../settings";
import type { BoundObjectStorage } from "./bound-object-storage";

export interface OffloadAllowlist {
  /** Hostnames the daemon may fetch offloaded refs from. Empty = none. */
  hosts: string[];
  /** Permit http:// loopback refs (dev MinIO over localhost). */
  allowSameHostDev: boolean;
}

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

/**
 * Mint a sample presigned GET URL and extract the host the daemon must allow.
 * Returns an empty allowlist when no object storage is configured (offload is
 * a hard "no" in that case anyway — `remoteDispatch` throws on oversized
 * bodies without storage).
 *
 * `allowSameHostDev` is true only when the derived host is loopback AND we are
 * not in production — so dev MinIO over http://127.0.0.1 is reachable while
 * production never relaxes the https requirement.
 */
export async function deriveOffloadAllowlist(
  objectStorage: BoundObjectStorage | null,
): Promise<OffloadAllowlist> {
  if (!objectStorage) return { hosts: [], allowSameHostDev: false };

  // A short-lived presign for a probe key; we only read its host, never fetch
  // it. `requireFetchable: true` makes DevObjectStorage (inline data: URLs)
  // throw straight away — it has no fetchable host to allow, exactly the same
  // condition the offload `put` hits, so we fail soft here (empty allowlist →
  // daemon rejects offload cleanly) instead of advertising an unusable host.
  // Real S3 signs locally, so a nonexistent probe key is fine.
  let url: string;
  try {
    url = await objectStorage.presignedGetUrl(
      "link-dispatch/_allowlist_probe",
      60,
      {
        requireFetchable: true,
      },
    );
  } catch {
    return { hosts: [], allowSameHostDev: false };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Non-fetchable (e.g. data:) URL — no host to allow.
    return { hosts: [], allowSameHostDev: false };
  }

  // Skip non-fetchable schemes (DevObjectStorage emits `data:` URLs in dev
  // without real S3). Nothing for the daemon to allow.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { hosts: [], allowSameHostDev: false };
  }

  const host = parsed.hostname;
  const isLoopback = LOOPBACK_HOSTS.has(host);
  const isProd = getSettings().nodeEnv === "production";

  return {
    hosts: [host],
    allowSameHostDev: isLoopback && !isProd,
  };
}
