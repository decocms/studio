/**
 * Pure helpers to swap a raw token inside a Tiptap doc for a secretRef node.
 * Kept free of editor/react imports so they stay unit-testable.
 */

import type { JSONContent } from "@tiptap/core";
import type { TiptapDoc } from "../../types.ts";
import type { SecretRefAttrs } from "./node.tsx";

function createSecretRefContent(attrs: SecretRefAttrs): JSONContent {
  return { type: "secretRef", attrs: { ...attrs } };
}

/**
 * Replace the FIRST occurrence of `rawValue` across the doc's text nodes with
 * an inline secretRef chip, preserving marks and surrounding text. Returns a
 * new doc, or `null` when the value isn't found (caller keeps the original).
 */
export function replaceSecretInTiptapDoc(
  doc: TiptapDoc,
  rawValue: string,
  attrs: SecretRefAttrs,
): TiptapDoc | null {
  if (!rawValue) return null;
  let replaced = false;

  const walk = (nodes: JSONContent[]): JSONContent[] =>
    nodes.flatMap((node): JSONContent[] => {
      if (replaced) return [node];

      if (node.type === "text" && typeof node.text === "string") {
        const idx = node.text.indexOf(rawValue);
        if (idx === -1) return [node];
        replaced = true;

        const before = node.text.slice(0, idx);
        const after = node.text.slice(idx + rawValue.length);
        const pieces: JSONContent[] = [];
        if (before) pieces.push({ ...node, text: before });
        pieces.push(createSecretRefContent(attrs));
        if (after) pieces.push({ ...node, text: after });
        return pieces;
      }

      if (Array.isArray(node.content)) {
        return [{ ...node, content: walk(node.content) }];
      }
      return [node];
    });

  const content = walk(doc.content ?? []);
  if (!replaced) return null;
  return { ...doc, content };
}

/**
 * Plain text of the doc's text nodes only — mention/file/secretRef chips are
 * skipped, so detection can't re-trigger on already-vaulted references.
 */
export function extractPlainTextFromTiptapDoc(
  doc: TiptapDoc | undefined,
): string {
  if (!doc) return "";
  let text = "";

  const walk = (node: JSONContent): void => {
    if (node.type === "text" && typeof node.text === "string") {
      text += node.text;
    }
    if (node.type === "paragraph" && text && !text.endsWith("\n")) {
      text += "\n";
    }
    for (const child of node.content ?? []) walk(child);
  };

  walk(doc);
  return text;
}
