/** Only allow remote https images in the editor (blocks javascript:, data:, etc.). */
export function safeEditorImageUrl(
  raw: string | undefined,
): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
