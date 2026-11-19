/**
 * Small pure helpers shared by the file-picker dialog and the Assets browser
 * for rendering object keys (extension tags, basenames, human sizes).
 */

export function isImageKey(key: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(key);
}

export function isVideoKey(key: string): boolean {
  return /\.(mp4|webm|mov|m4v|ogv)$/i.test(key);
}

export type AssetKind = "image" | "video" | "document";

export function assetKind(key: string): AssetKind {
  if (isImageKey(key)) return "image";
  if (isVideoKey(key)) return "video";
  return "document";
}

export function extensionTag(key: string): string {
  const dot = key.lastIndexOf(".");
  if (dot < 0 || dot === key.length - 1) return "file";
  return key.slice(dot + 1).toLowerCase();
}

export function basename(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] ?? key;
}

const UPLOAD_ID_PREFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(?=.)/i;

/** The file name a person uploaded: the basename without the upload's uuid prefix. */
export function displayName(key: string): string {
  return basename(key).replace(UPLOAD_ID_PREFIX, "");
}

function formatExtension(name: string): string {
  const ext = extensionTag(name);
  return ext === "jpeg" ? "jpg" : ext;
}

/** Whether `fileName` can replace `key` without changing its format. */
export function sameFormat(key: string, fileName: string): boolean {
  return formatExtension(key) === formatExtension(fileName);
}

/**
 * The URL a preview loads. A replace keeps the public URL, so the version
 * makes the browser fetch the new bytes instead of its cached copy.
 */
export function previewUrl(
  publicUrl: string,
  lastModified: string | null,
): string {
  const version = lastModified ? Date.parse(lastModified) : Number.NaN;
  if (Number.isNaN(version)) return publicUrl;
  return `${publicUrl}${publicUrl.includes("?") ? "&" : "?"}v=${version}`;
}

export interface Dimensions {
  width: number;
  height: number;
}

/** Whether two sizes differ in proportion by more than 1%. */
export function aspectRatioDiffers(a: Dimensions, b: Dimensions): boolean {
  if (a.height <= 0 || b.height <= 0) return false;
  const ratioA = a.width / a.height;
  const ratioB = b.width / b.height;
  return Math.abs(ratioA - ratioB) / ratioB > 0.01;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
