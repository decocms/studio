/**
 * One-click GitHub App registration via GitHub's App Manifest flow
 * (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
 *
 * 1. A deployment admin's browser POSTs `manifest` to
 *    `github.com/settings/apps/new` (or an organization's equivalent) with a
 *    `state` we signed.
 * 2. GitHub creates the App and redirects to the manifest's `redirect_url`
 *    with a one-time `code` and our `state`.
 * 3. We exchange the code at `POST /app-manifests/{code}/conversions` for the
 *    App's id, slug, client id/secret, webhook secret and private key.
 *
 * Everything the admin would otherwise copy into five environment variables
 * arrives in step 3, so nothing is pasted by hand.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { RegisteredGithubApp } from "./stored-app-config";

/** Path of the public redirect handler, under the `/api/_git` router. */
const GITHUB_MANIFEST_CALLBACK_PATH = "/api/_git/github/manifest-callback";

/**
 * The permissions Studio's GitHub features use — the same set the self-host
 * docs tell an operator to grant by hand (`selfhost/.../.env.example`).
 */
const DEFAULT_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  deployments: "read",
  metadata: "read",
} as const;

/** What the webhook route consumes; each needs a permission granted above. */
const WEBHOOK_EVENTS = ["push", "check_suite", "issue_comment"];

/** GitHub caps App names at 34 characters, and names are globally unique. */
const MAX_APP_NAME_LENGTH = 34;

/** A GitHub organization login: alphanumerics and single inner hyphens. */
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export function isValidGithubLogin(login: string): boolean {
  return GITHUB_LOGIN.test(login);
}

/**
 * A default App name derived from the deployment's host, so two self-hosted
 * instances don't collide on GitHub's global namespace. The admin can still
 * edit it on GitHub's confirmation page.
 */
export function defaultGithubAppName(publicUrl: string): string {
  const host = new URL(publicUrl).hostname.replace(/^www\./, "");
  return `Studio ${host}`.slice(0, MAX_APP_NAME_LENGTH).trim();
}

export function buildGithubAppManifest(opts: {
  publicUrl: string;
  name?: string;
  /** Installable on any account, not only the one that owns the App. */
  public: boolean;
}): Record<string, unknown> {
  const base = opts.publicUrl.replace(/\/+$/, "");
  const name = (opts.name?.trim() || defaultGithubAppName(base)).slice(
    0,
    MAX_APP_NAME_LENGTH,
  );
  return {
    name,
    url: base,
    redirect_url: `${base}${GITHUB_MANIFEST_CALLBACK_PATH}`,
    // The OAuth callback the connect flow already uses (`git-providers.ts`).
    callback_urls: [`${base}/api/_git/github/callback`],
    setup_url: `${base}/api/_git/github/setup`,
    setup_on_update: true,
    // The one webhook URL an App gets (`api/routes/github-webhook.ts`): pushes
    // refresh warm pools, check suites and comments refresh PR cards.
    hook_attributes: { url: `${base}/api/_github/webhook`, active: true },
    public: opts.public,
    default_permissions: DEFAULT_PERMISSIONS,
    default_events: WEBHOOK_EVENTS,
  };
}

/** Where the admin's browser POSTs the manifest. */
export function githubManifestFormAction(
  state: string,
  organization?: string,
): string {
  const path = organization
    ? `/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : "/settings/apps/new";
  return `https://github.com${path}?state=${encodeURIComponent(state)}`;
}

const STATE_TTL_MS = 30 * 60_000;

/**
 * A stateless, signed `state`: `<userId>.<expiresAt>.<nonce>.<mac>`, all
 * base64url. Binds the redirect to the admin who started it and expires, so a
 * code can't be redeemed through someone else's browser or much later. No row
 * to store: GitHub's code is single-use, which is the replay guard that
 * matters.
 */
export function signManifestState(
  userId: string,
  secret: string,
  now = Date.now(),
): string {
  const payload = [
    Buffer.from(userId).toString("base64url"),
    String(now + STATE_TTL_MS),
    randomBytes(12).toString("base64url"),
  ].join(".");
  return `${payload}.${mac(payload, secret)}`;
}

/** The user id the state was issued to, or null when forged or expired. */
export function verifyManifestState(
  state: string | undefined,
  secret: string,
  now = Date.now(),
): string | null {
  if (!state) return null;
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [user, expiresAt, nonce, signature] = parts as [
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(mac(`${user}.${expiresAt}.${nonce}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  if (!(Number(expiresAt) > now)) return null;
  return Buffer.from(user, "base64url").toString("utf8") || null;
}

function mac(payload: string, secret: string): string {
  return createHmac("sha256", `github-app-manifest:${secret}`)
    .update(payload)
    .digest("base64url");
}

/** GitHub's manifest codes are short hex-ish tokens; reject anything else. */
const MANIFEST_CODE = /^[\w-]{1,128}$/;

/**
 * Redeem the one-time code for the App's credentials. Unauthenticated by
 * design on GitHub's side: the code itself is the credential.
 */
export async function convertGithubManifestCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegisteredGithubApp> {
  if (!MANIFEST_CODE.test(code)) throw new Error("invalid manifest code");
  const res = await fetchImpl(
    `https://api.github.com/app-manifests/${code}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "decocms-studio",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub manifest conversion failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as {
    id?: unknown;
    slug?: unknown;
    client_id?: unknown;
    client_secret?: unknown;
    pem?: unknown;
    webhook_secret?: unknown;
    html_url?: unknown;
    owner?: { login?: unknown } | null;
  };
  const str = (v: unknown) =>
    typeof v === "string" && v.length > 0 ? v : null;
  const appId = typeof body.id === "number" ? String(body.id) : str(body.id);
  const slug = str(body.slug);
  const clientId = str(body.client_id);
  const clientSecret = str(body.client_secret);
  const privateKeyPem = str(body.pem);
  if (!appId || !slug || !clientId || !clientSecret || !privateKeyPem) {
    throw new Error("GitHub manifest conversion returned an incomplete App");
  }
  return {
    appId,
    slug,
    clientId,
    clientSecret,
    privateKeyPem,
    webhookSecret: str(body.webhook_secret),
    htmlUrl: str(body.html_url),
    ownerLogin: str(body.owner?.login),
  };
}
