/**
 * The two connections the blog will not start without: the store's VTEX
 * account, for every commerce read, and its GA4 property, for what readers do.
 *
 * Both sides need the same answer — the server refuses a generation, the
 * browser shows what is missing before anyone clicks — so the identity and
 * readiness rules live here, once.
 */

/** Prefix on the error a blog tool throws when either connection is not ready. */
export const BLOG_CONNECTIONS_MISSING = "blog-connections-missing:";

export const BLOG_CONNECTION_APPS = {
  vtex: { appName: "vtex", registryAppId: "deco/vtex" },
  ga4: { appName: "google-analytics", registryAppId: "deco/google-analytics" },
} as const;

export type BlogConnectionKind = keyof typeof BLOG_CONNECTION_APPS;

/**
 * Connections the blog reads when the organization has them and never waits
 * for: Search Console sharpens a hypothesis with what people search, but a
 * post can be argued from the store and its readers alone.
 */
export const BLOG_OPTIONAL_CONNECTION_APPS = {
  gsc: {
    appName: "google-search-console",
    registryAppId: "deco/google-search-console",
  },
} as const;

/** Every connection the blog reads, required or not. */
type BlogAppKind =
  | BlogConnectionKind
  | keyof typeof BLOG_OPTIONAL_CONNECTION_APPS;

const BLOG_APPS = { ...BLOG_CONNECTION_APPS, ...BLOG_OPTIONAL_CONNECTION_APPS };

/**
 * Why a connection cannot serve the blog yet, in the order someone fixes it:
 * install it, switch it on, give it its account, sign in.
 */
export type BlogConnectionGap =
  | "missing"
  | "inactive"
  | "unconfigured"
  | "unauthorized";

/** What the rules read of a connection — both sides have at least this. */
export interface BlogConnectionCandidate {
  id: string;
  app_name?: string | null;
  app_id?: string | null;
  status?: string | null;
  updated_at?: string | null;
  configuration_state?: Record<string, unknown> | null;
}

export interface BlogConnectionStatus {
  connectionId: string | null;
  gap: BlogConnectionGap | null;
}

export function isBlogConnection(
  kind: BlogAppKind,
  connection: Pick<BlogConnectionCandidate, "app_name" | "app_id">,
): boolean {
  const app = BLOG_APPS[kind];
  return (
    connection.app_name === app.appName ||
    connection.app_id === app.registryAppId
  );
}

/** The org's connection of a kind: an active one first, then the newest. */
export function pickBlogConnection<T extends BlogConnectionCandidate>(
  kind: BlogAppKind,
  connections: readonly T[],
): T | null {
  const matches = connections.filter((c) => isBlogConnection(kind, c));
  matches.sort((a, b) => {
    const rank = (c: T) => (c.status === "active" ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  });
  return matches[0] ?? null;
}

function filled(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The account each kind needs before it can answer. VTEX's private catalog —
 * product and SKU lookups — needs the app key and token, not just the account.
 */
function configured(
  kind: BlogAppKind,
  config: Record<string, unknown> | null | undefined,
): boolean {
  if (kind === "vtex") {
    return (
      filled(config?.accountName) &&
      filled(config?.appKey) &&
      filled(config?.appToken)
    );
  }
  if (kind === "gsc") return filled(config?.siteUrl);
  return filled(config?.propertyId);
}

/**
 * Whether a connection of a kind can serve the blog, and why not.
 *
 * `authorized` is the caller's word on sign-in, which each side checks its own
 * way: VTEX authenticates with its keys and is always authorized here; the
 * Google ones are authorized by a usable token. The Reports service account
 * does not count — it reads GA4 for Reports without any connection the blog
 * could call.
 */
export function blogConnectionStatus(
  kind: BlogAppKind,
  connection: BlogConnectionCandidate | null,
  authorized: boolean,
): BlogConnectionStatus {
  if (!connection) return { connectionId: null, gap: "missing" };
  const gap: BlogConnectionGap | null =
    connection.status !== "active"
      ? "inactive"
      : !configured(kind, connection.configuration_state)
        ? "unconfigured"
        : kind !== "vtex" && !authorized
          ? "unauthorized"
          : null;
  return { connectionId: connection.id, gap };
}

/** The message a refusal carries, naming what is missing. */
export function blogConnectionsMissingMessage(
  missing: readonly BlogConnectionKind[],
): string {
  return `${BLOG_CONNECTIONS_MISSING} ${missing.join(", ")}`;
}

/** Whether a thrown value is that refusal rather than a broken call. */
export function isBlogConnectionsMissing(err: unknown): boolean {
  return err instanceof Error && err.message.includes(BLOG_CONNECTIONS_MISSING);
}
