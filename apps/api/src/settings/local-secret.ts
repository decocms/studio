/**
 * Persisted local-mode auth secret.
 *
 * `bunx decocms` (local mode) ships with no BETTER_AUTH_SECRET. Without a stable
 * value Better Auth generates a fresh random secret every process start
 * (auth/index.ts), which both invalidates existing session cookies AND fails to
 * decrypt the encrypted JWKS private key persisted on the previous boot —
 * `GET /api/auth/get-session` then 500s and the user is bounced into an
 * unbreakable login loop.
 *
 * So on first local run we generate one random secret, persist it under the
 * data dir, and reuse it across restarts — a zero-config install "just works".
 *
 * This is deliberately NOT used for server deployments: those set
 * BETTER_AUTH_SECRET explicitly. A per-machine file is the wrong trust model
 * for a multi-node production cluster, where the secret must be shared config.
 */
import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SECRET_FILE = "local-auth-secret";

/**
 * Read the persisted local-mode auth secret from `dataDir`, generating and
 * writing one on first call. The returned value is stable across restarts.
 */
export function resolveLocalAuthSecret(dataDir: string): string {
  const path = join(dataDir, SECRET_FILE);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Missing or unreadable — fall through and create it.
  }
  const secret = randomBytes(32).toString("base64");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}
