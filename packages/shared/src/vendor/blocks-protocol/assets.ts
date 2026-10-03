/**
 * Asset-upload naming rules shared by the asset handler and the storages.
 * Browser-safe.
 */

/**
 * Every content type the asset endpoint accepts, with the file extensions a
 * file of that type may have (the first is the one appended to a name
 * without an extension). The stored file's extension decides the type it's
 * served with, so an upload can never pick one the browser would run, such
 * as `.html` or `.js`.
 */
export const ASSET_TYPES: Readonly<Record<string, readonly string[]>> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/avif": [".avif"],
  "image/gif": [".gif"],
  "image/x-icon": [".ico"],
  "image/vnd.microsoft.icon": [".ico"],
  "video/mp4": [".mp4"],
  "video/webm": [".webm"],
  "font/woff2": [".woff2"],
  "font/woff": [".woff"],
  "font/ttf": [".ttf"],
  "font/otf": [".otf"],
  "application/font-woff": [".woff"],
  "application/x-font-ttf": [".ttf"],
  "application/vnd.ms-fontobject": [".eot"],
  "application/pdf": [".pdf"],
};

/**
 * SVG can carry scripts, so it runs on the site's origin like HTML would.
 * Accepted only with `allowSvg`.
 */
export const SVG_ASSET_TYPE = { "image/svg+xml": [".svg"] } as const;

export interface AssetTypeOptions {
  /** Accept `image/svg+xml` uploads (default false: SVG can carry scripts). */
  allowSvg?: boolean;
}

const mediaType = (contentType: string | null) =>
  contentType ? contentType.split(";")[0]!.trim().toLowerCase() : "";

/** The extensions an upload of `contentType` may have; `null` when the type isn't accepted. */
export function assetExtensions(
  contentType: string | null,
  options: AssetTypeOptions = {},
): readonly string[] | null {
  const type = mediaType(contentType);
  if (Object.hasOwn(ASSET_TYPES, type)) return ASSET_TYPES[type] ?? null;
  if (options.allowSvg && type === "image/svg+xml")
    return SVG_ASSET_TYPE[type] ?? null;
  return null;
}

/** True when the asset endpoint accepts `contentType`. */
export function isAcceptedAssetType(
  contentType: string | null,
  options: AssetTypeOptions = {},
): boolean {
  return assetExtensions(contentType, options) !== null;
}

/**
 * Fits a sanitized file name to its content type: a name without an
 * extension gets the type's, and the extension is lowercased. Returns `null`
 * when the name's extension doesn't match the type (`evil.html` sent as
 * `image/png`), or the type isn't accepted.
 */
export function assetNameForType(
  name: string,
  contentType: string | null,
  options: AssetTypeOptions = {},
): string | null {
  const extensions = assetExtensions(contentType, options);
  if (!extensions) return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}${extensions[0]}`;
  const extension = name.slice(dot).toLowerCase();
  return extensions.includes(extension) ? name.slice(0, dot) + extension : null;
}

/**
 * Normalizes an upload's file name: its last path segment, lowercased
 * extension, with anything but letters, digits, `.`, `_` and `-` replaced.
 * Returns `null` when nothing usable is left.
 */
export function sanitizeAssetName(raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  name = name.split(/[\\/]/).pop() ?? "";
  name = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+(\.|$)/g, "$1");
  if (!name || name === "." || name === "..") return null;
  if (name.length > 200) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot).slice(0, 16) : "";
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

/**
 * The name to try when `name` is taken: a short random suffix before the
 * extension, such as `banner-3f9a2c.jpg`.
 */
export function suffixedAssetName(name: string): string {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)}-${suffix}${name.slice(dot)}`
    : `${name}-${suffix}`;
}
