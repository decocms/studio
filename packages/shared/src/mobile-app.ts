/**
 * A project that is an Eitri mobile app (`metadata.mobileApp`): its canvas
 * is only an approximation, and editors see the draft for real on a phone,
 * in the app's Dev build. Client-writable, like `previewServerUrl`; the
 * switch is on while the object is present.
 *
 * Eitri's convention fixes the link: the Dev build registers the scheme
 * `<protocol>-dev` (the protocol in the Eitri Console's app settings) and
 * opens a draft at `account/StudioPreview/<slug>/<path>`. Phone cameras
 * open https links, not custom schemes (Android's stock camera ignores
 * them), so the QR code points at Studio's public bridge page
 * ({@link OPEN_APP_PATH}), which builds the app link itself.
 */

export interface MobileAppConfig {
  /** The app's Eitri protocol (`newbalance`): its Dev build opens `newbalance-dev://`. */
  protocol: string;
  /** Where an iPhone installs the Dev build (e.g. TestFlight). */
  iosInstallUrl?: string;
  /** Where an Android phone installs the Dev build; the intent falls back to it. */
  androidInstallUrl?: string;
}

const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The project's mobile-app settings; null when the switch is off. */
export function mobileAppConfig(
  metadata: object | null | undefined,
): MobileAppConfig | null {
  const value = (metadata as Record<string, unknown> | null | undefined)
    ?.mobileApp;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  return {
    protocol: str(raw.protocol) ?? "",
    iosInstallUrl: str(raw.iosInstallUrl),
    androidInstallUrl: str(raw.androidInstallUrl),
  };
}

/** An Eitri app protocol: a URL scheme's characters, lowercase. */
export function isAppProtocol(protocol: unknown): protocol is string {
  return typeof protocol === "string" && /^[a-z][a-z0-9+.-]*$/.test(protocol);
}

const SLUG_RE = /^[A-Za-z0-9_-]+$/;

/** `…/sites/<site>/drafts/<slug>/index.json@<token>` (a v8 draft pointer). */
const DRAFT_FOLDER_RE =
  /\/sites\/[^/]+\/drafts\/([A-Za-z0-9_-]+)\/index\.json(?:[?@]|$)/;

/** The draft folder a v8 `__draft` pointer names; null for anything else. */
export function draftSlug(pointer: string | null | undefined): string | null {
  return pointer?.match(DRAFT_FOLDER_RE)?.[1] ?? null;
}

/** What opens a draft in the app: the bridge page's query. */
export interface OpenAppParams {
  protocol: string;
  /** The draft folder. */
  slug: string;
  /** The page open in the editor; `""` when unknown. */
  path: string;
  /** iOS install page. */
  ios?: string;
  /** Android install page. */
  apk?: string;
}

/** The Dev build's link to a draft page: `<protocol>-dev://account/StudioPreview/<slug>/<path>`. */
export function mobileAppLink({
  protocol,
  slug,
  path,
}: Pick<OpenAppParams, "protocol" | "slug" | "path">): string {
  return `${protocol}-dev://account/StudioPreview/${slug}/${encodeURIComponent(path)}`;
}

/** An https URL (an install page). */
export function isHttpsUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Studio's public page that opens a draft in the app on the phone that loads it. */
export const OPEN_APP_PATH = "/open-app";

/**
 * The bridge page's https URL on `origin`. An install page that is not
 * https is left out, so the page still opens the app.
 */
export function openAppUrl(origin: string, params: OpenAppParams): string {
  const url = new URL(OPEN_APP_PATH, origin);
  url.searchParams.set("protocol", params.protocol);
  url.searchParams.set("slug", params.slug);
  url.searchParams.set("path", params.path);
  if (isHttpsUrl(params.ios)) url.searchParams.set("ios", params.ios);
  if (isHttpsUrl(params.apk)) url.searchParams.set("apk", params.apk);
  return url.href;
}

/** The bridge page's query, validated; null when any value is not what its name says. */
export function parseOpenAppParams(
  search: Record<string, unknown>,
): OpenAppParams | null {
  const { protocol, slug, path = "", ios, apk } = search;
  if (!isAppProtocol(protocol)) return null;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return null;
  if (typeof path !== "string") return null;
  if (ios !== undefined && !isHttpsUrl(ios)) return null;
  if (apk !== undefined && !isHttpsUrl(apk)) return null;
  return {
    protocol,
    slug,
    path,
    ...(ios ? { ios } : {}),
    ...(apk ? { apk } : {}),
  };
}

/**
 * Chrome's way to open the app link: `intent://<rest>#Intent;scheme=
 * <protocol>-dev;S.browser_fallback_url=<apk>;end`. Without the app, Chrome
 * goes to the fallback (the install page), when there is one.
 */
export function androidIntentUrl(params: OpenAppParams): string {
  const link = mobileAppLink(params);
  const rest = link.slice(link.indexOf("://") + 3);
  return [
    `intent://${rest}#Intent`,
    `scheme=${params.protocol}-dev`,
    ...(params.apk
      ? [`S.browser_fallback_url=${encodeURIComponent(params.apk)}`]
      : []),
    "end",
  ].join(";");
}

/** The phone the bridge page is on, from its user agent. */
export function appPlatform(
  userAgent: string,
  maxTouchPoints = 0,
): "android" | "ios" | "desktop" {
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ipod/i.test(userAgent)) return "ios";
  // iPadOS asks for the desktop site: a touch "Macintosh".
  if (/macintosh/i.test(userAgent) && maxTouchPoints > 1) return "ios";
  return "desktop";
}
