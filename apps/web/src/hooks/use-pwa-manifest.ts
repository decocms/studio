import { useLayoutEffect } from "react";
import { clearPwaInstallPrompt } from "@/lib/pwa-install";

/**
 * Per-organization PWA install.
 *
 * Studio ships a single static manifest ("deco Studio", see
 * apps/web/public/manifest.webmanifest) that stays active on every route, so
 * the browser's own "Add to Home Screen" installs Studio itself. This hook is
 * used ONLY on the dedicated org install page (routes/org-install.tsx, at
 * /{slug}/install): it OVERRIDES that manifest while the page is mounted so an
 * install taken there produces a distinct, org-branded app — named after the
 * org, opening straight into /{slug}, with the org's logo as the icon. Each org
 * gets a different manifest `id`/`start_url`, so browsers treat them as separate
 * installable apps — one home-screen app per org. On unmount (leaving the page)
 * the original Studio defaults are restored.
 *
 * The manifest is generated client-side as a `data:` URL — no server route —
 * which behaves identically in dev and prod. iOS ignores the web manifest for
 * home-screen installs, so the icon and title also flow through the
 * `apple-touch-icon` link and `apple-mobile-web-app-title` meta tag, which we
 * update alongside the manifest.
 *
 * Swapping the manifest invalidates any `beforeinstallprompt` Chromium captured
 * for the previous manifest, so we clear it on both apply and restore (see
 * clearPwaInstallPrompt) — the captured prompt always matches the active app.
 *
 * DOM mutation in a layout effect matches the established pattern in
 * theme-provider.tsx (useLayoutEffect, not the banned useEffect).
 */

const THEME_COLOR = "#f6f4ed";
const BACKGROUND_COLOR = "#ffffff";
const DEFAULT_ICONS = [
  { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
];

export interface PwaOrg {
  name: string;
  slug: string;
  logo?: string | null;
}

function buildManifestDataUrl(org: PwaOrg, origin: string): string {
  const startUrl = `${origin}/${org.slug}`;

  // Prefer the org logo as the icon; always append the default PNGs so the
  // 192/512 installability criteria are met even when the logo is missing or
  // an odd size. Cross-origin icons (e.g. an S3 logo URL) are fetched fine by
  // browsers from a data: manifest.
  const icons = [
    ...(org.logo
      ? [
          { src: org.logo, sizes: "192x192", purpose: "any" },
          { src: org.logo, sizes: "512x512", purpose: "any" },
          { src: org.logo, sizes: "any", purpose: "any" },
        ]
      : []),
    ...DEFAULT_ICONS,
  ];

  const manifest = {
    id: startUrl,
    name: org.name,
    short_name: org.name,
    start_url: startUrl,
    scope: startUrl,
    display: "standalone",
    display_override: ["window-controls-overlay"],
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    icons,
  };

  return `data:application/manifest+json,${encodeURIComponent(
    JSON.stringify(manifest),
  )}`;
}

function findOrCreateLink(rel: string): HTMLLinkElement {
  const existing = document.querySelector<HTMLLinkElement>(
    `link[rel="${rel}"]`,
  );
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = rel;
  document.head.appendChild(link);
  return link;
}

function findOrCreateMeta(name: string): HTMLMetaElement {
  const existing = document.querySelector<HTMLMetaElement>(
    `meta[name="${name}"]`,
  );
  if (existing) return existing;
  const meta = document.createElement("meta");
  meta.name = name;
  document.head.appendChild(meta);
  return meta;
}

/**
 * Override the document's PWA install metadata for the given org, restoring the
 * Studio defaults when the org changes or the component unmounts. Pass `null`
 * to leave the defaults in place (e.g. before the active org has loaded).
 */
export function usePwaManifest(org: PwaOrg | null): void {
  const name = org?.name ?? "";
  const slug = org?.slug ?? "";
  const logo = org?.logo ?? "";

  useLayoutEffect(() => {
    if (!slug || !name) return;
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const manifestLink = findOrCreateLink("manifest");
    const appleIcon = findOrCreateLink("apple-touch-icon");
    const appleTitle = findOrCreateMeta("apple-mobile-web-app-title");

    // Snapshot the current (default) values so we can restore them precisely
    // when leaving the org — this is what keeps generic Studio install working
    // on neutral routes.
    const prev = {
      manifest: manifestLink.getAttribute("href"),
      appleIcon: appleIcon.getAttribute("href"),
      appleTitle: appleTitle.getAttribute("content"),
      title: document.title,
    };

    manifestLink.setAttribute(
      "href",
      buildManifestDataUrl(
        { name, slug, logo: logo || null },
        window.location.origin,
      ),
    );
    // iOS reads apple-touch-icon, not the manifest. SVG logos won't render as a
    // home-screen icon on iOS — those orgs fall back to the deco default.
    if (logo) appleIcon.setAttribute("href", logo);
    appleTitle.setAttribute("content", name);
    document.title = name;

    // The Studio prompt captured at startup is bound to the old manifest; drop
    // it so the install button can only fire the org prompt Chromium re-fires
    // for the manifest we just applied.
    clearPwaInstallPrompt();

    return () => {
      // Restore prior values. setAttribute(null) isn't valid, so remove the
      // attribute when there was no prior value.
      if (prev.manifest !== null)
        manifestLink.setAttribute("href", prev.manifest);
      if (prev.appleIcon !== null)
        appleIcon.setAttribute("href", prev.appleIcon);
      if (prev.appleTitle !== null) {
        appleTitle.setAttribute("content", prev.appleTitle);
      }
      document.title = prev.title;
      // Org manifest is gone; drop its captured prompt too.
      clearPwaInstallPrompt();
    };
  }, [name, slug, logo]);
}
