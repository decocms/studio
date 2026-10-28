/**
 * A drafted post's sections as something the card can draw.
 *
 * The sections are the draft's `{ type, props, productIds }`, in the shapes
 * the blog's own blocks take: a Paragraph's `html`, a Heading's `text`, a
 * List's newline-separated `items`. A model wrote them, so a paragraph's HTML
 * is read with `DOMParser` into a tree of the inline tags a paragraph may
 * keep — the same allowlist imports are held to — and drawn as elements, never
 * as markup.
 */

import { IMAGE_SENTINEL } from "@decocms/shared/blog-image-sentinel";
import {
  ALLOWED_INLINE,
  isSafeUrl,
} from "@/components/sandbox/content/blog/import-content";

export type InlineTag =
  | "a"
  | "b"
  | "strong"
  | "i"
  | "em"
  | "u"
  | "s"
  | "code"
  | "span"
  | "sub"
  | "sup";

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "break" }
  | {
      kind: "element";
      tag: InlineTag;
      href?: string;
      children: InlineNode[];
    };

export type BodyBlock =
  | { kind: "heading"; level: 2 | 3 | 4; text: string }
  | { kind: "paragraph"; content: InlineNode[] }
  | { kind: "list"; ordered: boolean; items: InlineNode[][] }
  | { kind: "quote"; text: string }
  /** `url` is null while the illustrator has not drawn it yet. */
  | { kind: "image"; url: string | null; alt: string }
  | { kind: "component"; name: string; productIds: string[] };

/** Elements whose content is code, never text. */
const DROPPED = /^(script|style|template|iframe|object|embed|noscript)$/;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function children(nodes: NodeListOf<ChildNode>): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) out.push(...inline(node));
  return out;
}

function inline(node: ChildNode): InlineNode[] {
  if (node.nodeType === 3) {
    const text = node.textContent ?? "";
    return text ? [{ kind: "text", text }] : [];
  }
  if (node.nodeType !== 1) return [];
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (DROPPED.test(tag)) return [];
  if (!ALLOWED_INLINE.test(tag)) return children(element.childNodes);
  if (tag === "br") return [{ kind: "break" }];
  const href = tag === "a" ? (element.getAttribute("href") ?? "") : "";
  return [
    {
      kind: "element",
      tag: tag as InlineTag,
      ...(href && isSafeUrl(href) ? { href } : {}),
      children: children(element.childNodes),
    },
  ];
}

/** A paragraph's HTML as the inline tree it may keep. */
export function inlineNodes(html: string): InlineNode[] {
  if (!html.trim()) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  return children(doc.body.childNodes);
}

function headingLevel(value: unknown): 2 | 3 | 4 {
  const digit = Number(String(value ?? "").replace(/\D/g, ""));
  return digit >= 4 ? 4 : digit === 3 ? 3 : 2;
}

function listItems(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "string"
          ? item
          : str((item as Record<string, unknown> | null)?.text),
      )
      .filter((item) => item.trim());
  }
  return str(value)
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** One drafted section as a block, or null when it has nothing to show. */
function bodyBlock(section: unknown): BodyBlock | null {
  const record = (section ?? {}) as Record<string, unknown>;
  const type = str(record.type);
  const props = (record.props ?? {}) as Record<string, unknown>;
  switch (type) {
    case "Paragraph": {
      const content = inlineNodes(str(props.html));
      return content.length > 0 ? { kind: "paragraph", content } : null;
    }
    case "Heading": {
      const text = str(props.text).trim();
      return text
        ? { kind: "heading", level: headingLevel(props.level), text }
        : null;
    }
    case "Quote": {
      const text = str(props.quote).trim();
      return text ? { kind: "quote", text } : null;
    }
    case "List": {
      const items = listItems(props.items).map(inlineNodes);
      return items.length > 0
        ? { kind: "list", ordered: str(props.style) === "ordered", items }
        : null;
    }
    case "BlockImage":
    case "Image": {
      const url = str(props.url ?? props.src ?? props.image).trim();
      if (!url) return null;
      return {
        kind: "image",
        url: url.startsWith(IMAGE_SENTINEL) || !isSafeUrl(url) ? null : url,
        alt: str(props.alt),
      };
    }
    default: {
      if (!type) return null;
      const ids = Array.isArray(record.productIds)
        ? record.productIds.filter((id): id is string => typeof id === "string")
        : [];
      return { kind: "component", name: type, productIds: ids };
    }
  }
}

/** The draft's sections as blocks, in reading order. */
export function bodyBlocks(sections: readonly unknown[]): BodyBlock[] {
  return sections
    .map(bodyBlock)
    .filter((block): block is BodyBlock => block !== null);
}
