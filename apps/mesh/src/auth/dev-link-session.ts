/**
 * Dev-only helper to bootstrap an OAuth-ish session file for the
 * desktop-side link daemon when it auto-spawns out of `bun run dev`.
 *
 * In production the link reads a real OAuth session minted by
 * `decocms auth login`. Locally we have no such login flow — the dev
 * cluster boots in `localMode`, seeds an admin user, and is the only
 * thing the link talks to. To avoid asking the developer to manually
 * `auth login` against their own dev cluster, we mint a Better Auth
 * API key for the local admin user at first dev boot and serialize it
 * in the `Session` shape `apps/mesh/src/cli/lib/session.ts` defines.
 *
 * The link then presents that API key as a Bearer token to
 * `POST /api/links`. The cluster's `getAuthenticatedUserSub` resolves
 * it via `auth.api.verifyApiKey` and returns the local admin's userSub.
 *
 * Idempotent — exits early if the session file already exists.
 *
 * Only runs when `MESH_ALLOW_LOCALHOST_LINKS=1` is set, which we
 * default to in `bun run dev`. Production never sets that flag.
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getDb } from "@/database";
import { auth } from "./index";
import { getLocalAdminUser, isLocalMode } from "./local-mode";

export interface DevLinkSession {
  target: string;
  clientId: string;
  user: { sub: string; email?: string; name?: string };
  accessToken: string;
  createdAt: string;
}

function devLinkDataDir(homeDir: string): string {
  return join(homeDir, "dev-link");
}

function devLinkSessionPath(homeDir: string): string {
  // `DEV_LINK_SESSION_PATH` is set by the dev CLI (`apps/mesh/src/cli/commands/dev.ts`)
  // so the cluster writes session.json to the same tmpdir-based location
  // the auto-spawned link daemon reads from. Falls back to the legacy
  // `<homeDir>/dev-link/session.json` for callers that haven't migrated
  // yet (manual dev:server invocations, tests).
  const override = process.env.DEV_LINK_SESSION_PATH;
  if (override && override.trim() !== "") return override;
  return join(devLinkDataDir(homeDir), "session.json");
}

/**
 * Mint a dev session for the link daemon so it can register against the
 * local cluster without a real OAuth flow. Writes to
 * `<homeDir>/dev-link/session.json` (mode 0600). Idempotent — returns
 * the existing path if the file is already there.
 *
 * Returns the session path on success, or null when bootstrap could not
 * complete (no admin user yet, API key mint failed). The caller is
 * expected to surface a warning and skip auto-spawning the link rather
 * than crashing dev boot.
 */
export async function bootstrapDevLinkSession(
  homeDir: string,
  clusterBaseUrl: string,
): Promise<{ path: string; userSub: string } | null> {
  const path = devLinkSessionPath(homeDir);

  // Resolve the user the link should represent. In local mode this is the
  // seeded admin (the same user the browser auto-logs-in as), pinned by its
  // stable `<username>@localhost.mesh` email. Pinning to the email — rather
  // than "most-recently-created user" — prevents a leftover e2e run (which
  // seeds throwaway `*@playwright.local` users with newer createdAt) from
  // hijacking the dev link and producing a user_desktop_link_offline mismatch
  // when dispatch looks the claim up under the browser's userId.
  const db = getDb().db;
  const user = isLocalMode()
    ? await getLocalAdminUser()
    : await db
        .selectFrom("user")
        .select(["id", "email", "name"])
        .orderBy("createdAt", "desc")
        .executeTakeFirst();
  if (!user?.id) return null;

  if (existsSync(path)) {
    // Re-use the existing session file iff it belongs to the resolved user
    // *and* its API key still verifies. A user mismatch (stale file from a
    // prior session/e2e run) or an invalid key (DB wipe, rotation, expiry)
    // forces a re-mint, making restarts self-healing without manual cleanup.
    try {
      const file = Bun.file(path);
      const json = (await file.json()) as {
        user?: { sub?: string };
        accessToken?: string;
      };
      const sub = json.user?.sub;
      const key = json.accessToken;
      if (sub === user.id && typeof key === "string") {
        const verified = await auth.api
          .verifyApiKey({ body: { key } })
          .then((r: { valid?: boolean } | null) => r?.valid === true)
          .catch(() => false);
        if (verified) return { path, userSub: sub };
      }
    } catch {
      // fall through and re-mint
    }
  }

  let apiKey: { key?: string } | null = null;
  try {
    apiKey = (await auth.api.createApiKey({
      body: {
        name: "dev-link (auto-minted by bun run dev)",
        userId: user.id,
        // 30 days — re-minted on file deletion, far longer than any
        // single dev session.
        expiresIn: 60 * 60 * 24 * 30,
        rateLimitEnabled: false,
      },
    })) as { key?: string } | null;
  } catch (err) {
    console.warn(
      "[dev-link] failed to mint API key:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!apiKey?.key) return null;

  const session: DevLinkSession = {
    target: clusterBaseUrl,
    clientId: "dev-link",
    user: {
      sub: user.id,
      ...(user.email ? { email: user.email } : {}),
      ...(user.name ? { name: user.name } : {}),
    },
    accessToken: apiKey.key,
    createdAt: new Date().toISOString(),
  };

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);

  return { path, userSub: user.id };
}
