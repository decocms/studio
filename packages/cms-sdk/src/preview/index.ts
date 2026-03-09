/**
 * Preview URL Utilities
 *
 * Utilities for building preview URLs for the iframe preview system.
 */

import type { Block } from "../blocks/index.ts";

/**
 * Viewport types for preview
 */
export type Viewport = "mobile" | "tablet" | "desktop";

/**
 * Viewport dimensions
 */
export const VIEWPORT_SIZES: Record<
  Viewport,
  { width: number; height: number }
> = {
  mobile: { width: 412, height: 823 }, // Moto G Power
  tablet: { width: 1024, height: 1366 }, // iPad Pro
  desktop: { width: 1280, height: 800 }, // MacBook Pro 14
};

/**
 * Options for building preview URLs
 */
export interface PreviewOptions {
  /** The URL path to preview (e.g., "/", "/products/123") */
  path?: string;
  /** The path template for validation (e.g., "/products/*") */
  pathTemplate?: string;
  /** The viewport size hint */
  viewport?: Viewport;
  /** Matcher overrides for A/B testing */
  matchers?: Record<string, boolean>;
  /** Cache buster string (defaults to timestamp) */
  cacheBuster?: string;
  /** Disable async rendering */
  disableAsync?: boolean;
}

/**
 * Encode props for URL transmission.
 * Uses base64 encoding of URL-encoded JSON.
 */
export function encodeProps(props: unknown): string {
  const json = JSON.stringify(props);
  return btoa(encodeURIComponent(json));
}

/**
 * Decode props from URL.
 */
export function decodeProps<T = unknown>(encoded: string): T {
  const json = decodeURIComponent(atob(encoded));
  return JSON.parse(json);
}

/**
 * Build a preview URL for a block.
 *
 * @example
 * const url = buildPreviewUrl('https://mysite.deco.site', {
 *   __resolveType: 'website/pages/Page.tsx',
 *   name: 'Home',
 *   path: '/',
 *   sections: []
 * }, { viewport: 'mobile' });
 */
export function buildPreviewUrl(
  siteUrl: string,
  block: Block,
  options: PreviewOptions = {}
): string {
  const { __resolveType, ...props } = block;

  if (!__resolveType) {
    throw new Error("Block must have __resolveType");
  }

  const url = new URL(`${siteUrl}/live/previews/${__resolveType}`);

  // Path parameters
  const path = options.path || "/";
  url.searchParams.set("path", path);
  url.searchParams.set("pathTemplate", options.pathTemplate || path);

  // Props (encoded)
  url.searchParams.set("props", encodeProps(props));

  // Viewport hint
  if (options.viewport) {
    url.searchParams.set("deviceHint", options.viewport);
  }

  // Matcher overrides
  if (options.matchers) {
    for (const [matcherId, active] of Object.entries(options.matchers)) {
      url.searchParams.append(
        "x-deco-matchers-override",
        `${matcherId}=${active ? 1 : 0}`
      );
    }
  }

  // Disable async rendering for consistent preview
  if (options.disableAsync !== false) {
    url.searchParams.set("__decoFBT", "0");
    url.searchParams.set("__d", "");
  }

  // Cache buster
  url.searchParams.set(
    "__cb",
    options.cacheBuster || Date.now().toString()
  );

  return url.toString();
}

/**
 * Build a standalone URL for opening the page in a new tab.
 */
export function buildStandaloneUrl(
  siteUrl: string,
  path: string,
  matchers?: Record<string, boolean>
): string {
  const url = new URL(path, siteUrl);

  // Add matcher overrides if any
  if (matchers) {
    for (const [matcherId, active] of Object.entries(matchers)) {
      url.searchParams.append(
        "x-deco-matchers-override",
        `${matcherId}=${active ? 1 : 0}`
      );
    }
  }

  return url.toString();
}

/**
 * Build a section preview URL by wrapping it in a minimal page.
 */
export function buildSectionPreviewUrl(
  siteUrl: string,
  section: Block,
  options: PreviewOptions = {}
): string {
  // Wrap section in a minimal page
  const pageWrapper: Block = {
    __resolveType: "website/pages/Page.tsx",
    path: options.path || "/",
    sections: [section],
  };

  return buildPreviewUrl(siteUrl, pageWrapper, {
    ...options,
    path: options.path || "/",
  });
}

/**
 * Check if a block can be previewed.
 * Only pages, sections, and apps can be previewed.
 */
export function canPreview(resolveType: string): boolean {
  return (
    resolveType.includes("/pages/") ||
    resolveType.includes("/sections/") ||
    resolveType.includes("/apps/")
  );
}

