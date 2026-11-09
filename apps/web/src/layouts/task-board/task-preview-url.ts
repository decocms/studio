import { marked } from "marked";
import { parseStructuredBlock } from "@/components/structured-markdown/schema";

function previewUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

/** First valid testing destination wins; PR order matches the task's links. */
export function taskPreviewUrl(
  description: string | null,
  prs: readonly { previewUrl?: string | null }[],
): string | null {
  for (const token of marked.lexer(description ?? "")) {
    if (token.type !== "code" || token.lang !== "testing") continue;
    const block = parseStructuredBlock(token.lang, token.text);
    if (block?.kind === "testing" && block.data.previewUrl)
      return block.data.previewUrl;
  }
  for (const pr of prs) {
    const url = previewUrl(pr.previewUrl);
    if (url) return url;
  }
  return null;
}
