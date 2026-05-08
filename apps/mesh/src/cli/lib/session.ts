import {
  chmod,
  mkdir,
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

export function sessionPath(dataDir: string): string {
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

export async function writeSession(
  dataDir: string,
  session: Session,
): Promise<void> {
  const path = sessionPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  // Write to a temp path, force mode 0600 (writeFile's `mode` is ignored when
  // overwriting an existing file), then atomically rename into place.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export async function clearSession(dataDir: string): Promise<void> {
  await rm(sessionPath(dataDir), { force: true });
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
