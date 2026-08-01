/**
 * Signing secret for dev-assets presigned URLs — the local-filesystem
 * DevObjectStorage backend used when no S3/R2/MinIO is configured.
 *
 * Falls back to ENCRYPTION_KEY when set; otherwise generates a random,
 * process-lifetime secret (same trade-off as STUDIO_JWT_SECRET in
 * auth/jwt.ts) instead of a fixed string baked into this open-source repo —
 * anyone reading the source would otherwise know a deployment's signing
 * secret whenever ENCRYPTION_KEY is left unset, letting them forge presigned
 * URLs for any org's dev assets.
 */
import { randomBytes } from "crypto";
import { getSettings } from "../settings";

let devAssetsSecret: string | null = null;

export function getDevAssetsSigningSecret(): string {
  if (devAssetsSecret) return devAssetsSecret;

  const configured = getSettings().encryptionKey;
  if (configured) {
    devAssetsSecret = configured;
  } else {
    console.warn(
      "ENCRYPTION_KEY not set - generating a random dev-assets signing secret (not persistent across restarts)",
    );
    devAssetsSecret = randomBytes(32).toString("base64");
  }
  return devAssetsSecret;
}
