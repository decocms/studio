/**
 * Small pure helpers shared by the file-picker dialog and the Assets browser
 * for rendering object keys (extension tags, basenames, human sizes).
 */

export function isImageKey(key: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(key);
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

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
