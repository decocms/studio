/**
 * The GitHub App registered from the admin dashboard (GitHub's App Manifest
 * flow), as the fallback for `readGithubAppConfig` when the `GITHUB_APP_*`
 * environment variables are not set.
 *
 * `readGithubAppConfig` is synchronous and called on hot paths (capabilities,
 * credentials, the OAuth callback), so the row is held in memory here and the
 * reader never touches the database. The cache is filled at boot, replaced on
 * save, and re-read on an interval so every replica of a multi-pod deployment
 * picks up a registration made through a different one.
 */

import type { Kysely } from "kysely";
import { getDb } from "@/database";
import { CredentialVault } from "@/encryption/credential-vault";
import { getSettings } from "@/settings";
import type { Database } from "@/storage/types";
import type { GithubAppConfig } from "./env";

/** What GitHub's `POST /app-manifests/{code}/conversions` hands back. */
export interface RegisteredGithubApp extends GithubAppConfig {
  webhookSecret: string | null;
  htmlUrl: string | null;
  ownerLogin: string | null;
}

/** Non-secret facts about the stored App, for the admin dashboard. */
export interface StoredGithubAppInfo {
  appId: string;
  slug: string;
  htmlUrl: string | null;
  ownerLogin: string | null;
  createdAt: string;
}

let cached: GithubAppConfig | null = null;
let cachedWebhookSecret: string | null = null;

/** The stored App, from memory. Null until loaded, or when none is stored. */
export function storedGithubAppConfig(): GithubAppConfig | null {
  return cached;
}

/** The stored App's webhook secret, from memory. */
export function storedGithubWebhookSecret(): string | null {
  return cached ? cachedWebhookSecret : null;
}

/** Test seam: replace the in-memory copy without a database. */
export function setStoredGithubAppConfigForTest(
  config: GithubAppConfig | null,
  webhookSecret: string | null = null,
): void {
  cached = config;
  cachedWebhookSecret = webhookSecret;
}

function defaultDeps(): { db: Kysely<Database>; vault: CredentialVault } {
  return {
    db: getDb().db,
    vault: new CredentialVault(getSettings().encryptionKey),
  };
}

/**
 * Re-read the row into memory. Never throws: a database hiccup keeps the
 * previous copy (a working App must not blink off on a transient error), and a
 * row that cannot be decrypted — the encryption key rotated — is treated as
 * absent, with a log line saying why.
 */
async function refreshStoredGithubAppConfig(
  deps = defaultDeps(),
): Promise<GithubAppConfig | null> {
  let row;
  try {
    row = await deps.db
      .selectFrom("deployment_github_app")
      .select([
        "app_id",
        "slug",
        "client_id",
        "encrypted_client_secret",
        "encrypted_private_key",
        "encrypted_webhook_secret",
      ])
      .where("id", "=", "default")
      .executeTakeFirst();
  } catch (error) {
    console.warn("[git-providers] stored GitHub App lookup failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return cached;
  }
  if (!row) {
    cached = null;
    cachedWebhookSecret = null;
    return null;
  }
  try {
    cached = {
      appId: row.app_id,
      slug: row.slug,
      clientId: row.client_id,
      clientSecret: await deps.vault.decrypt(row.encrypted_client_secret),
      privateKeyPem: await deps.vault.decrypt(row.encrypted_private_key),
    };
    cachedWebhookSecret = row.encrypted_webhook_secret
      ? await deps.vault.decrypt(row.encrypted_webhook_secret)
      : null;
  } catch (error) {
    console.error(
      "[git-providers] the stored GitHub App cannot be decrypted — was the " +
        "encryption key changed? Register the App again from the admin " +
        "dashboard.",
      { message: error instanceof Error ? error.message : String(error) },
    );
    cached = null;
    cachedWebhookSecret = null;
  }
  return cached;
}

/** Persist a freshly registered App (replacing any previous one) and cache it. */
export async function saveStoredGithubAppConfig(
  app: RegisteredGithubApp,
  createdBy: string | null,
  deps = defaultDeps(),
): Promise<void> {
  const values = {
    app_id: app.appId,
    slug: app.slug,
    client_id: app.clientId,
    encrypted_client_secret: await deps.vault.encrypt(app.clientSecret),
    encrypted_private_key: await deps.vault.encrypt(app.privateKeyPem),
    encrypted_webhook_secret: app.webhookSecret
      ? await deps.vault.encrypt(app.webhookSecret)
      : null,
    html_url: app.htmlUrl,
    owner_login: app.ownerLogin,
    created_by: createdBy,
    created_at: new Date(),
  };
  await deps.db
    .insertInto("deployment_github_app")
    .values({ id: "default", ...values })
    .onConflict((oc) => oc.column("id").doUpdateSet(values))
    .execute();
  cached = {
    appId: app.appId,
    slug: app.slug,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    privateKeyPem: app.privateKeyPem,
  };
  cachedWebhookSecret = app.webhookSecret;
}

/**
 * Forget the stored App. The App itself stays on GitHub — deleting it there is
 * the admin's call, and existing installations keep working against any
 * deployment that still holds its key.
 */
export async function deleteStoredGithubAppConfig(
  deps = defaultDeps(),
): Promise<void> {
  await deps.db
    .deleteFrom("deployment_github_app")
    .where("id", "=", "default")
    .execute();
  cached = null;
  cachedWebhookSecret = null;
}

/** The stored App's public facts, or null when none is stored. */
export async function storedGithubAppInfo(
  deps = defaultDeps(),
): Promise<StoredGithubAppInfo | null> {
  const row = await deps.db
    .selectFrom("deployment_github_app")
    .select(["app_id", "slug", "html_url", "owner_login", "created_at"])
    .where("id", "=", "default")
    .executeTakeFirst();
  if (!row) return null;
  return {
    appId: row.app_id,
    slug: row.slug,
    htmlUrl: row.html_url,
    ownerLogin: row.owner_login,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const SYNC_INTERVAL_MS = 60_000;
let syncTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Load now and keep re-reading. Called once at boot; idempotent. The timer is
 * unref'd so it never holds the process open on shutdown.
 */
export function startGithubAppConfigSync(): void {
  if (syncTimer) return;
  void refreshStoredGithubAppConfig();
  syncTimer = setInterval(() => {
    void refreshStoredGithubAppConfig();
  }, SYNC_INTERVAL_MS);
  syncTimer.unref?.();
}
