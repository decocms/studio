/**
 * Read the OAuth session from `<dataDir>/session.json`, matching
 * the shape `decocms auth login` writes (see
 * `apps/mesh/src/cli/lib/session.ts`). Reading is read-only on the
 * link side — minting a new session must go through the `decocms`
 * CLI's `auth login`.
 *
 * Returns null if no session file exists or the contents fail to
 * validate; the link's main entry surfaces a "run decocms auth login
 * first" message in that case.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Session {
  target: string;
  clientId: string;
  user: { sub: string; email?: string; name?: string };
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  createdAt: string;
}

function sessionPath(dataDir: string): string {
  // Mirrors `apps/mesh/src/cli/lib/session.ts:sessionPath` so the link
  // reads the same file `decocms auth login` writes. `dataDir` is the
  // user's deco home (default `~/deco`), so the resolved path is
  // `~/deco/session.json`.
  return join(dataDir, "session.json");
}

export async function readSession(dataDir: string): Promise<Session | null> {
  try {
    const raw = await readFile(sessionPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isSession(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.target !== "string" ||
    typeof v.clientId !== "string" ||
    typeof v.accessToken !== "string" ||
    typeof v.createdAt !== "string"
  ) {
    return false;
  }
  if (!v.user || typeof v.user !== "object") return false;
  const u = v.user as Record<string, unknown>;
  if (typeof u.sub !== "string") return false;
  return true;
}
