/** Shared filename helpers for ImageField/FileField previews (URL → display name/extension). */
export function basename(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split("/").pop() ?? url);
  } catch {
    return url.split("/").pop() ?? url;
  }
}

export function extension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}
