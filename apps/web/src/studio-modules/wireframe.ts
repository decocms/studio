/**
 * Wireframe: Studio's section outline inside a Blocks v8 site's page, loaded
 * through the page's Studio channel (see `./messages.ts`). While the Blocks
 * panel edits the page (`wireframe:activate`), it outlines the editable
 * section under the pointer, colored by kind (normal, saved, with variants),
 * and reports the hovered and the clicked one by their index in the page's
 * sections array. The page doesn't navigate away meanwhile: only a real
 * navigation's default action is cancelled, never propagation, so in-page
 * controls keep working.
 *
 * The page's runtime renders framework sections (SEO, Theme, Analytics)
 * around and between the editable ones; Studio sends the keys each editable
 * section may render (`wireframe:sections`) and the wireframe aligns them
 * within the DOM by key (`alignSections`), so those drop out on their own.
 *
 * A section is any element carrying `data-manifest-key` with no such element
 * above it, not only a `<section>`: a site can mark the root of a section its
 * layout renders (a `<header>`, a `<footer>`) without changing its tag. Markers
 * inside a section are its own (a Lazy's inner section, a block rendering
 * another block's markup), so they never count as sections of the page.
 *
 * It moved here from the script Studio injected into the page
 * (`cms-editor-script.ts`, which v7 sites keep).
 */
import { alignSections } from "../components/sandbox/preview/section-alignment";
import { defineStudioModule } from "./channel";
import {
  HTML_SWAP_EVENT,
  type HtmlSwapEventDetail,
  type WireframeIn,
  type WireframeOut,
  type WireframeSectionKind,
} from "./messages";

/** Any marked element; a page section is the outermost one (`isTopLevel`). */
const SECTION_SELECTOR = "[data-manifest-key]";

/** A Lazy wrapper's key is only the loader's: the label shows the inner section's. */
const LAZY_KEYS = [
  "website/sections/Rendering/Lazy.tsx",
  "website/sections/Rendering/SingleDeferred.tsx",
];

const COLORS: Record<
  WireframeSectionKind,
  { solid: string; bg: string; active: string }
> = {
  normal: {
    solid: "#06b6d4",
    bg: "rgba(6,182,212,0.06)",
    active: "rgba(6,182,212,0.18)",
  },
  global: {
    solid: "#c084fc",
    bg: "rgba(192,132,252,0.10)",
    active: "rgba(192,132,252,0.22)",
  },
  variant: {
    solid: "#22c55e",
    bg: "rgba(34,197,94,0.08)",
    active: "rgba(34,197,94,0.20)",
  },
};

/**
 * The page's scroll offset survives the loads the editor makes (a variant
 * picked navigates the frame): kept per path in sessionStorage, restored on
 * the next load for a moment so it outlasts hydration and lazy sections.
 */
function keepScroll(): void {
  const key = `__cms_preview_scroll:${location.pathname}`;
  let pending = false;
  addEventListener(
    "scroll",
    () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        try {
          sessionStorage.setItem(
            key,
            JSON.stringify({ x: scrollX, y: scrollY, t: Date.now() }),
          );
        } catch {
          // Storage off: nothing to keep.
        }
      });
    },
    { passive: true },
  );
  let saved: { x?: number; y?: number; t?: number } | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
  } catch {
    return;
  }
  if (!saved || Date.now() - (saved.t ?? 0) > 10_000) return;
  if (!saved.x && !saved.y) return;
  const { x = 0, y = 0 } = saved;
  let attempts = 0;
  const apply = () => {
    attempts++;
    scrollTo(x, y);
    if (attempts < 8) setTimeout(apply, 120);
  };
  apply();
}

/** A link that leaves the page (not a fragment, not `javascript:`). */
function navigatesAway(a: HTMLAnchorElement | null): boolean {
  const href = a?.getAttribute("href")?.trim();
  if (!a || !href || href.startsWith("#") || /^javascript:/i.test(href)) {
    return false;
  }
  try {
    const url = new URL(a.href, location.href);
    if (url.href.split("#")[0] === location.href.split("#")[0]) return false;
  } catch {
    // An unparsable href: the browser decides.
  }
  return true;
}

export default defineStudioModule<WireframeIn, WireframeOut>((channel) => {
  const doc = document;
  const outline = doc.createElement("div");
  outline.dataset.decoWireframe = "outline";
  outline.style.cssText =
    "position:absolute;pointer-events:none;border-radius:2px;z-index:2147483647;display:none;";
  const badge = doc.createElement("div");
  badge.dataset.decoWireframe = "badge";
  badge.style.cssText =
    "position:absolute;pointer-events:none;color:white;font:11px/1 monospace;padding:2px 6px;border-radius:2px;z-index:2147483647;display:none;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;";

  let active = false;
  /** While HTML swap replaces the document: no hover until it's done. */
  let swapping = false;
  let labels: string[] = [];
  let kinds: WireframeSectionKind[] = [];
  let candidates: (string[] | null)[] = [];
  let hovered: Element | null = null;
  let hoveredIndex: number | null = null;
  let kind: WireframeSectionKind = "normal";
  let label = "";
  let framePending = false;
  let clickSeq = 0;

  const isTopLevel = (el: Element) =>
    !el.parentElement?.closest(SECTION_SELECTOR);

  /** The editable sections, indexed like the page's sections array (unmapped: null). */
  const editableSections = (): (Element | null)[] => {
    const tops = Array.from(doc.querySelectorAll(SECTION_SELECTOR)).filter(
      isTopLevel,
    );
    if (!candidates.length) return tops;
    const domKeys = tops.map((s) => s.getAttribute("data-manifest-key"));
    return alignSections(candidates, domKeys).map((i) =>
      i === null ? null : (tops[i] ?? null),
    );
  };

  /** The outermost page section `el` is in, with its index; null outside an editable one. */
  const sectionAt = (
    el: Element | null,
  ): { section: Element; index: number } | null => {
    let found: Element | null = null;
    for (let node = el; node && node !== doc.body; node = node.parentElement) {
      if (node.matches(SECTION_SELECTOR)) found = node;
    }
    if (!found) return null;
    const index = editableSections().indexOf(found);
    return index < 0 ? null : { section: found, index };
  };

  const displayKey = (section: Element) => {
    const key = section.getAttribute("data-manifest-key") || "section";
    if (LAZY_KEYS.some((lazy) => key.endsWith(lazy))) {
      const inner = section.querySelector(SECTION_SELECTOR);
      if (inner) return inner.getAttribute("data-manifest-key") || key;
    }
    return key;
  };

  const paint = (background: "bg" | "active" = "bg") => {
    const color = COLORS[kind] ?? COLORS.normal;
    outline.style.outline = `2px solid ${color.solid}`;
    outline.style.background = color[background];
    badge.style.background = color.solid;
  };

  /** Document coordinates: the outline scrolls with the page, natively. */
  const place = (section: Element) => {
    const r = section.getBoundingClientRect();
    const top = r.top + scrollY;
    const left = r.left + scrollX;
    Object.assign(outline.style, {
      display: "block",
      top: `${top}px`,
      left: `${left}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    badge.textContent = label || displayKey(section);
    Object.assign(badge.style, {
      display: "block",
      top: `${Math.max(0, top - 20)}px`,
      left: `${left}px`,
    });
  };

  const hide = () => {
    outline.style.display = "none";
    badge.style.display = "none";
  };

  const hover = (next: { section: Element; index: number } | null) => {
    const index = next?.index ?? null;
    hovered = next?.section ?? null;
    if (index !== hoveredIndex) {
      hoveredIndex = index;
      channel.send({ type: "wireframe:hover", sectionIndex: index });
    }
    if (!next) {
      hide();
      return;
    }
    label = labels[next.index] || "";
    kind = kinds[next.index] ?? "normal";
    paint();
    place(next.section);
  };

  const onMove = (event: MouseEvent) => {
    if (swapping || framePending) return;
    framePending = true;
    const target = event.target as Element | null;
    requestAnimationFrame(() => {
      framePending = false;
      if (!active || swapping || !target || target === outline) return;
      if (target === badge) return;
      const next = sectionAt(target);
      if (next?.section === hovered) return;
      hover(next);
    });
  };

  /** Window scrolls move the outline natively; a nested scroller or a resize doesn't. */
  const onReflow = () => {
    if (!hovered || outline.style.display === "none" || framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      if (hovered && outline.style.display !== "none") place(hovered);
    });
  };

  const onOut = (event: MouseEvent) => {
    const to = event.relatedTarget;
    if (!to || to === doc.documentElement) hover(null);
  };

  /** Observes clicks to select a section; never cancels the page's own handlers. */
  const onClick = (event: MouseEvent) => {
    const target = event.target as Element | null;
    if (!target || target === outline || target === badge) return;
    const anchor = target.closest?.("a") ?? null;
    if (navigatesAway(anchor)) event.preventDefault();
    const at = sectionAt(target);
    if (!at) return;
    paint("active");
    setTimeout(() => paint(), 400);
    clickSeq++;
    channel.send({
      type: "wireframe:select",
      sectionIndex: at.index,
      manifestKey: at.section.getAttribute("data-manifest-key") || "",
      clickSeq,
    });
  };

  const onSubmit = (event: Event) => event.preventDefault();

  const onSwap = (event: Event) => {
    const { phase } = (event as CustomEvent<HtmlSwapEventDetail>).detail ?? {};
    if (phase === "start") {
      swapping = true;
      hide();
      return;
    }
    if (phase !== "end") return;
    swapping = false;
    // The old body went with the old document.
    if (active) doc.body.append(outline, badge);
    hover(null);
  };

  const activate = () => {
    if (active) return;
    active = true;
    doc.body.append(outline, badge);
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("mouseout", onOut, true);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("submit", onSubmit, true);
    addEventListener("scroll", onReflow, { capture: true, passive: true });
    addEventListener("resize", onReflow, { passive: true });
  };

  const deactivate = () => {
    if (!active) return;
    active = false;
    hover(null);
    outline.remove();
    badge.remove();
    doc.removeEventListener("mousemove", onMove, true);
    doc.removeEventListener("mouseout", onOut, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("submit", onSubmit, true);
    removeEventListener("scroll", onReflow, { capture: true });
    removeEventListener("resize", onReflow);
  };

  keepScroll();
  addEventListener(HTML_SWAP_EVENT, onSwap);
  channel.on((message) => {
    switch (message.type) {
      case "wireframe:activate":
        activate();
        return;
      case "wireframe:deactivate":
        deactivate();
        return;
      case "wireframe:clear-hover":
        hover(null);
        return;
      case "wireframe:sections": {
        labels = Array.isArray(message.labels) ? message.labels : [];
        kinds = Array.isArray(message.kinds) ? message.kinds : [];
        candidates = Array.isArray(message.keys) ? message.keys : [];
        if (!hovered) return;
        const index = editableSections().indexOf(hovered);
        hoveredIndex = index < 0 ? null : index;
        if (index < 0) {
          hover(null);
          return;
        }
        label = labels[index] || "";
        kind = kinds[index] ?? "normal";
        paint();
        if (outline.style.display !== "none") place(hovered);
        return;
      }
    }
  });
});
