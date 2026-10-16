/**
 * Pure HTML-source transforms for deck edit ops.
 *
 * The DeckTab keeps the deck's HTML source as a string; each op from the
 * preview iframe (which already self-applied the change to its own DOM)
 * is replayed here against the source via DOMParser, then the result is
 * PUT back to org-fs. Whole-document parse → mutate → serialize: decks
 * are generated single-file HTML, so the round-trip is stable enough,
 * and ops only ever touch `<deck-viewer>`'s element children.
 *
 * Throws `DeckOpError` when the source no longer matches the op (slide
 * count drifted — e.g. the agent rewrote the file between iframe load
 * and the user's edit). Callers should resync the iframe on that.
 */

import type { DeckOp } from "./deck-messages";

const UNSAFE_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "link",
  "meta",
  "base",
]);

const URL_ATTRS = new Set([
  "href",
  "src",
  "xlink:href",
  "action",
  "formaction",
]);

function isSafeUrlAttrValue(value: string): boolean {
  const trimmed = value.trim();
  if (/^data:image\//i.test(trimmed)) return true;
  return !/^(javascript|vbscript|data):/i.test(trimmed);
}

function isSafeAttr(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) return false;
  if (URL_ATTRS.has(lower)) return isSafeUrlAttrValue(value);
  return true;
}

/** Strips script/embed-style tags and event-handler/URL-scheme attributes
 *  from untrusted HTML before it's parsed into the deck source. */
function sanitizeSlideFragment(root: Element): void {
  for (const el of [
    ...root.querySelectorAll(`${[...UNSAFE_TAGS].join(",")}`),
  ]) {
    el.remove();
  }
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      if (!isSafeAttr(attr.name, attr.value)) el.removeAttribute(attr.name);
    }
  }
}

export class DeckOpError extends Error {
  constructor(
    message: string,
    readonly code: "no-viewer" | "stale-index" | "bad-op",
  ) {
    super(message);
    this.name = "DeckOpError";
  }
}

/** Slide elements = element children of <deck-viewer>, excluding non-slide
 *  tags (mirrors the runtime's `_collectSlides`). */
function slidesOf(viewer: Element): Element[] {
  return [...viewer.children].filter(
    (el) => !/^(TEMPLATE|SCRIPT|STYLE)$/.test(el.tagName),
  );
}

export function countDeckSlides(source: string): number | null {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const viewer = doc.querySelector("deck-viewer");
  return viewer ? slidesOf(viewer).length : null;
}

export function applyDeckOp(source: string, op: DeckOp): string {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const viewer = doc.querySelector("deck-viewer");
  if (!viewer) {
    throw new DeckOpError("no <deck-viewer> element in source", "no-viewer");
  }
  const slides = slidesOf(viewer);
  const at = op.kind === "move" ? op.from : op.at;
  const slide = slides[at];
  if (!slide) {
    throw new DeckOpError(
      `slide index ${at} out of range (${slides.length})`,
      "stale-index",
    );
  }

  switch (op.kind) {
    case "remove": {
      if (slides.length <= 1) {
        throw new DeckOpError("cannot remove the last slide", "bad-op");
      }
      slide.remove();
      break;
    }
    case "duplicate": {
      const copy = slide.cloneNode(true) as Element;
      copy.removeAttribute("id");
      for (const el of copy.querySelectorAll("[id]")) {
        el.removeAttribute("id");
      }
      slide.after(copy);
      break;
    }
    case "move": {
      if (op.to < 0 || op.to >= slides.length) {
        throw new DeckOpError(
          `move target ${op.to} out of range`,
          "stale-index",
        );
      }
      if (op.to !== op.from) {
        // Same semantics as the runtime: insert before the slide currently
        // at `to` when moving up, after it when moving down.
        const ref =
          op.to < op.from ? slides[op.to]! : slides[op.to]!.nextSibling;
        viewer.insertBefore(slide, ref);
      }
      break;
    }
    case "set-attr": {
      if (!/^[a-zA-Z][\w-]*$/.test(op.name)) {
        throw new DeckOpError(`invalid attribute name: ${op.name}`, "bad-op");
      }
      if (!isSafeAttr(op.name, op.value)) {
        throw new DeckOpError(`unsafe attribute: ${op.name}`, "bad-op");
      }
      slide.setAttribute(op.name, op.value);
      break;
    }
    case "remove-attr": {
      slide.removeAttribute(op.name);
      break;
    }
    case "replace": {
      const fragment = new DOMParser().parseFromString(op.html, "text/html");
      sanitizeSlideFragment(fragment.body);
      const replacement = fragment.body.firstElementChild;
      if (!replacement) {
        throw new DeckOpError("replace html has no root element", "bad-op");
      }
      slide.replaceWith(doc.importNode(replacement, true));
      break;
    }
    default: {
      throw new DeckOpError(
        `unknown op kind: ${(op as { kind?: string }).kind}`,
        "bad-op",
      );
    }
  }

  const doctype = source.trimStart().toLowerCase().startsWith("<!doctype")
    ? "<!DOCTYPE html>\n"
    : "";
  return `${doctype}${doc.documentElement.outerHTML}\n`;
}
