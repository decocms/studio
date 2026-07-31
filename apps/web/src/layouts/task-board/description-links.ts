/**
 * Extract outbound links from a task's description markdown, deduped, for the
 * Links panel. Markdown link text becomes the label; embedded images are
 * dropped — an uploaded screenshot is part of the description, not a link out
 * of it. Pure so it's unit-testable.
 */
export function extractDescriptionLinks(
  text: string,
): { url: string; label: string }[] {
  if (!text) return [];
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  const add = (url: string, label: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, label: label.trim() || url });
  };

  // Strip images first so their URLs never reach the bare-URL sweep below.
  const withoutImages = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");

  for (const m of withoutImages.matchAll(
    /\[([^\]]*)\]\((https?:\/\/[^)\s]+)[^)]*\)/g,
  )) {
    add(m[2] ?? "", m[1] ?? "");
  }

  // Bare URLs, with markdown links removed so their hrefs aren't relabelled
  // with the URL after already being added with their link text.
  const bare = withoutImages.replace(/\[[^\]]*\]\([^)]*\)/g, "");
  for (const m of bare.matchAll(/https?:\/\/[^\s)]+/g)) {
    add(m[0], m[0]);
  }

  return out;
}
