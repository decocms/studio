import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Session {
  /** OAuth issuer / decocms target (e.g. https://studio.decocms.com). */
  target: string;
  /** Dynamically-registered OAuth client id for this CLI install. */
  clientId: string;
  /** OIDC subject identifier (stable per user). */
  user: { sub: string; email?: string; name?: string };
  /** Bearer token used for API + Warp tunnel auth. */
  accessToken: string;
  /** Refresh token for renewing the access token (when granted). */
  refreshToken?: string;
  /** Unix epoch (seconds) when accessToken expires, when known. */
  expiresAt?: number;
  /** ISO timestamp when this session was minted. */
  createdAt: string;
}

/**
 * Path to the session file for a studio. Sessions are keyed by studio host
 * so multiple studios (prod, staging, …) coexist in one data dir. Omitting
 * `target` yields the legacy `session.json` — still written by the dev-link
 * bootstrap and read as a fallback.
 */
export function sessionPath(dataDir: string, target?: string): string {
  if (!target) return join(dataDir, "session.json");
  return join(dataDir, `session.${sessionKey(target)}.json`);
}

/** Filename-safe key derived from a studio's host (incl. port). */
function sessionKey(target: string): string {
  let host = target;
  try {
    host = new URL(target).host;
  } catch {
    // not a URL — fall through with the raw string
  }
  return host.replace(/[^a-zA-Z0-9.-]/g, "_") || "default";
}

async function readSessionFile(path: string): Promise<Session | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isSession(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** All session file paths in `dataDir` (legacy `session.json` + host-keyed). */
async function listSessionPaths(dataDir: string): Promise<string[]> {
  try {
    const names = await readdir(dataDir);
    return names
      .filter((n) => /^session(\..+)?\.json$/.test(n))
      .map((n) => join(dataDir, n));
  } catch {
    return [];
  }
}

/**
 * Reads the session for `target` (host-keyed), falling back to the legacy
 * `session.json`. With no `target`, returns any session on disk (legacy file
 * first, then the first host-keyed file) — for target-agnostic callers like
 * `whoami` / `logout`.
 */
export async function readSession(
  dataDir: string,
  target?: string,
): Promise<Session | null> {
  const primary = await readSessionFile(sessionPath(dataDir, target));
  if (primary) return primary;
  if (target) {
    // Legacy single-file fallback (e.g. the dev-link bootstrap writes this).
    return readSessionFile(sessionPath(dataDir));
  }
  for (const path of await listSessionPaths(dataDir)) {
    const session = await readSessionFile(path);
    if (session) return session;
  }
  return null;
}

export async function writeSession(
  dataDir: string,
  session: Session,
): Promise<void> {
  const path = sessionPath(dataDir, session.target);
  await mkdir(dirname(path), { recursive: true });
  // Write to a temp path, force mode 0600 (writeFile's `mode` is ignored when
  // overwriting an existing file), then atomically rename into place.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/**
 * Removes session files. With `target`, removes just that studio's session;
 * without, removes every session file in the dir (full logout).
 */
export async function clearSession(
  dataDir: string,
  target?: string,
): Promise<void> {
  if (target) {
    await rm(sessionPath(dataDir, target), { force: true });
    return;
  }
  for (const path of await listSessionPaths(dataDir)) {
    await rm(path, { force: true });
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
