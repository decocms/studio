import {
  type Extensions,
  generateHTML,
  generateJSON,
  type JSONContent,
} from "@tiptap/core";
import { marked } from "marked";
import { safeImageSrc } from "@/components/sections-editor/fields/safe-image-url";
import { looksLikeHtml } from "../import-content";
import { legacyContentExtensions } from "./legacy-content-extensions";

/** What an empty editor serializes to; stored as "" so the body reads as empty. */
export function blankIfEmpty(html: string): string {
  return html === "<p></p>" ? "" : html;
}

function textOf(node: JSONContent): string {
  return node.text ?? (node.content ?? []).map(textOf).join("");
}

/**
 * The document without images whose `src` must never reach the site, nor the
 * paragraphs left empty by dropping them.
 */
function withSafeImages(node: JSONContent): JSONContent | null {
  if (node.type === "image") {
    const src = safeImageSrc(String(node.attrs?.src ?? ""));
    return src ? { ...node, attrs: { ...node.attrs, src } } : null;
  }
  if (!node.content?.length) return node;
  const content = node.content
    .map(withSafeImages)
    .filter((child) => child !== null);
  return content.length || node.type === "doc" ? { ...node, content } : null;
}

function parseSafe(html: string, extensions: Extensions): JSONContent {
  return withSafeImages(generateJSON(html, extensions)) ?? { type: "doc" };
}

/** `html` as the legacy body editor would save it. */
export function normalizeLegacyHtml(html: string): string {
  const extensions = legacyContentExtensions();
  return blankIfEmpty(generateHTML(parseSafe(html, extensions), extensions));
}

/**
 * Pasted or uploaded HTML/Markdown as a legacy post: the first H1 becomes the
 * title, as in the blocks import, and the rest is the body HTML for
 * `post.content`, kept to what the body editor can show and save.
 */
export function importAsLegacyContent(input: string): {
  title: string;
  content: string;
} {
  const trimmed = input.trim();
  if (!trimmed) return { title: "", content: "" };
  const html = looksLikeHtml(trimmed)
    ? trimmed
    : marked.parse(trimmed, { async: false });

  const extensions = legacyContentExtensions();
  const doc = parseSafe(html, extensions);
  const nodes = doc.content ?? [];
  const titleAt = nodes.findIndex(
    (node) => node.type === "heading" && node.attrs?.level === 1,
  );
  const title = titleAt >= 0 ? textOf(nodes[titleAt]!).trim() : "";
  const body = nodes.filter((_, index) => index !== titleAt);
  if (body.length === 0) return { title, content: "" };
  return {
    title,
    content: blankIfEmpty(generateHTML({ ...doc, content: body }, extensions)),
  };
}
