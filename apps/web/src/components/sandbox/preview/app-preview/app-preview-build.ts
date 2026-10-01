import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { KEYS } from "@/lib/query-keys";

/**
 * App preview builds (`kind: "eitri-app"`). The app repo's CI publishes a
 * self-contained preview of every code commit to the org's object storage —
 * `app-preview/<project>/<sha>/studio.html`, immutable — plus a small pointer
 * per branch (`branches/<branch>.json`) and one for the default branch
 * (`default.json`). A project opts in by setting its preview server to that
 * folder, `<studio>/api/<org>/files/app-preview/<project>/`, so the canvas
 * needs no sandbox and no server per customer: content comes from the same
 * `?__draft=` pointer sites use, edits from the in-place render bridge.
 */

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_POINTER_BYTES = 4096;
/** While CI builds new code, look again soon; otherwise once a minute. */
const PENDING_POLL_MS = 10_000;
const IDLE_POLL_MS = 60_000;

/** `previewServerUrl` when it is this Studio's app-preview storage folder, else null. */
export function appPreviewBuildBase(
  previewServerUrl: string | null | undefined,
  studioOrigin: string,
): string | null {
  if (!previewServerUrl) return null;
  try {
    const url = new URL(previewServerUrl);
    return url.origin === studioOrigin &&
      !url.search &&
      !url.hash &&
      /^\/api\/[^/]+\/files\/app-preview\/[^?#]+\/$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const AppBuildPointerSchema = z.object({
  kind: z.literal("eitri-app"),
  /** Commit whose build the canvas opens. */
  sha: z.string().regex(SHA_RE),
  /** A newer code commit CI is still building. */
  pending: z.string().regex(SHA_RE).optional().catch(undefined),
  /** `.deco/app.json` `previewLink` at that commit; validated where it is used. */
  previewLink: z.string().max(512).optional().catch(undefined),
});

export type AppBuildPointer = z.infer<typeof AppBuildPointerSchema>;

export function parseAppBuildPointer(body: string): AppBuildPointer | null {
  if (body.length > MAX_POINTER_BYTES) return null;
  try {
    const parsed = AppBuildPointerSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The branch's own pointer first, then the default branch's. */
export function appBuildPointerUrls(base: string, branch: string): string[] {
  const path = branch.split("/").map(encodeURIComponent).join("/");
  return [`${base}branches/${path}.json`, `${base}default.json`];
}

export const appBuildSrc = (base: string, sha: string) =>
  `${base}${sha}/studio.html`;

/**
 * The URL Studio built for a site (`<server>/<page>?__draft=…`, or a
 * `/live/previews/…?props=` thumbnail) re-aimed at the build: the page goes in
 * `__path`, every query param rides along.
 */
export function toAppBuildSrc(
  buildSrc: string,
  siteUrl: string | null,
): string | null {
  if (!siteUrl) return null;
  try {
    const site = new URL(siteUrl);
    const out = new URL(buildSrc);
    out.searchParams.set("__path", site.pathname);
    for (const [key, value] of site.searchParams) {
      out.searchParams.set(key, value);
    }
    return out.href;
  } catch {
    return null;
  }
}

async function fetchPointer(url: string): Promise<AppBuildPointer | null> {
  // The pointer is mutable while `/files` caches for a day: bypass the cache.
  const res = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  }).catch(() => null);
  if (!res?.ok) return null;
  const body = await res.text().catch(() => null);
  return body === null ? null : parseAppBuildPointer(body);
}

export interface AppPreviewBuild extends AppBuildPointer {
  /** The immutable build of `sha`. */
  src: string;
}

/** The build the canvas opens for `branch`; null when the project has none. */
export function useAppPreviewBuild(
  base: string | null,
  branch: string | null,
): AppPreviewBuild | null {
  const { data } = useQuery({
    queryKey: KEYS.appPreviewBuild(base ?? "", branch ?? ""),
    queryFn: async () => {
      for (const url of appBuildPointerUrls(base!, branch!)) {
        const pointer = await fetchPointer(url);
        if (pointer)
          return { ...pointer, src: appBuildSrc(base!, pointer.sha) };
      }
      return null;
    },
    enabled: !!base && !!branch,
    refetchInterval: (query) =>
      query.state.data?.pending ? PENDING_POLL_MS : IDLE_POLL_MS,
    retry: false,
  });
  return base && branch ? (data ?? null) : null;
}

/**
 * Schemes a `previewLink` may use besides `https://*.eitri.tech`: the Eitri
 * dev app's deep link. Add the scheme Eitri confirms for the store's dev app.
 */
const PREVIEW_LINK_SCHEMES = new Set(["eitri"]);
const DRAFT_SLOT = "{draft}";

/**
 * `.deco/app.json` `previewLink` (`<link>{draft}`) filled with this branch's
 * draft pointer — what "View on phone" encodes as the QR. Null for anything
 * but an Eitri https link or an allowed app scheme with exactly one slot.
 */
export function fillPreviewLink(
  template: string | null | undefined,
  draftPointer: string | null,
): string | null {
  if (!template || !draftPointer || template.length > 512) return null;
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\s\u0000-\u001f"'<>\\`]/.test(template)) return null;
  if (template.split(DRAFT_SLOT).length !== 2) return null;
  let url: URL;
  try {
    // Two neutral values in the slot must give the same origin: the draft can't pick the host.
    url = new URL(template.replace(DRAFT_SLOT, "x"));
    if (new URL(template.replace(DRAFT_SLOT, "y")).host !== url.host) {
      return null;
    }
  } catch {
    return null;
  }
  const scheme = url.protocol.slice(0, -1);
  const allowed =
    scheme === "https"
      ? !url.username &&
        !url.password &&
        !url.port &&
        /(^|\.)eitri\.tech$/.test(url.hostname)
      : PREVIEW_LINK_SCHEMES.has(scheme);
  return allowed
    ? template.replace(DRAFT_SLOT, encodeURIComponent(draftPointer))
    : null;
}
