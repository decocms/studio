import { z } from "zod";

export const CmsEditorPayloadSchema = z.object({
  sectionIndex: z.number(),
  manifestKey: z.string(),
});

export type CmsEditorPayload = z.infer<typeof CmsEditorPayloadSchema>;

/**
 * Self-contained script injected into the preview iframe for CMS mode.
 * Highlights full page sections (top-level <section data-manifest-key>) on
 * hover and posts the section's index — matching the decofile sections array —
 * back to the parent on click.
 *
 * Framework sections that deco injects around the page's editable sections
 * (SEO, Theme, Analytics, etc.) are NOT part of the page's sections array, so
 * they're filtered out via IGNORED_MANIFEST_KEYS to keep DOM order aligned with
 * the index the editor panel uses.
 */
export const IGNORED_MANIFEST_KEYS = [
  "website/sections/Seo/SeoV2.tsx",
  "site/sections/Theme/Theme.tsx",
  "htmx/sections/htmx.tsx",
  "website/sections/Analytics/Analytics.tsx",
  "site/sections/Session.tsx",
  "site/sections/Miscellaneous/CartAlert.tsx",
] as const;

export const CMS_EDITOR_SCRIPT = `(function() {
  if (window.__cmsEditorActive) return;
  window.__cmsEditorActive = true;

  var IGNORED_KEYS = ${JSON.stringify(
    Object.fromEntries(IGNORED_MANIFEST_KEYS.map((k) => [k, 1])),
  )};

  var highlight = document.createElement("div");
  highlight.style.cssText = "position:absolute;pointer-events:none;outline:2px solid #06b6d4;background:rgba(6,182,212,0.06);border-radius:2px;z-index:2147483647;display:none;";
  document.body.appendChild(highlight);

  var badge = document.createElement("div");
  badge.style.cssText = "position:absolute;pointer-events:none;background:#06b6d4;color:white;font:11px/1 monospace;padding:2px 6px;border-radius:2px;z-index:2147483647;display:none;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;";
  document.body.appendChild(badge);

  var isTopLevelSection = function(el) {
    return el && el.parentElement
      ? !el.parentElement.closest("section[data-manifest-key]")
      : true;
  };

  // Resolve to the OUTERMOST page-level section: deco renders page sections as
  // <section data-manifest-key>, but nested islands/sections carry the attribute
  // too. Walk up and keep the last section ancestor so clicking nested content
  // still maps to the top-level section the panel indexes. Framework sections
  // (IGNORED_KEYS) aren't in the editable array, so treat them as no section.
  var findSection = function(el) {
    var node = el;
    var found = null;
    while (node && node !== document.body) {
      if (node.tagName === "SECTION" && node.hasAttribute && node.hasAttribute("data-manifest-key")) {
        found = node;
      }
      node = node.parentElement;
    }
    if (found && IGNORED_KEYS[found.getAttribute("data-manifest-key")]) return null;
    return found;
  };

  // Only top-level, non-framework page sections, in DOM order, so indexOf
  // matches the decofile sections array the editor panel indexes into.
  var getAllSections = function() {
    return Array.from(document.querySelectorAll("section[data-manifest-key]"))
      .filter(isTopLevelSection)
      .filter(function(s) { return !IGNORED_KEYS[s.getAttribute("data-manifest-key")]; });
  };

  // Lazy sections async-render their real section inside a wrapper, so the
  // wrapper's key is just the loader. Show the inner section's key instead
  // (falling back to the wrapper while the content hasn't loaded yet).
  var LAZY_KEY = "website/sections/Rendering/Lazy.tsx";
  var displayKey = function(section) {
    var key = section.getAttribute("data-manifest-key") || "section";
    if (key === LAZY_KEY) {
      var inner = section.querySelector("section[data-manifest-key]");
      if (inner) return inner.getAttribute("data-manifest-key") || key;
    }
    return key;
  };

  // Per-section metadata sent by the editor, aligned by index with
  // getAllSections(). labels: names the DOM can't carry (a global section or a
  // global inside async rendering); kinds: section type that drives the color.
  var sectionLabels = [];
  var sectionKinds = [];
  var labelFor = function(section) {
    var idx = getAllSections().indexOf(section);
    if (idx >= 0 && sectionLabels[idx]) return sectionLabels[idx];
    return displayKey(section);
  };
  var kindFor = function(section) {
    var idx = getAllSections().indexOf(section);
    return (idx >= 0 && sectionKinds[idx]) || "normal";
  };

  // Highlight palette by section kind: global = light purple, variant = green,
  // normal = blue.
  var COLORS = {
    normal: { solid: "#06b6d4", bg: "rgba(6,182,212,0.06)", active: "rgba(6,182,212,0.18)" },
    global: { solid: "#c084fc", bg: "rgba(192,132,252,0.10)", active: "rgba(192,132,252,0.22)" },
    variant: { solid: "#22c55e", bg: "rgba(34,197,94,0.08)", active: "rgba(34,197,94,0.20)" }
  };
  var applyColor = function(kind) {
    var c = COLORS[kind] || COLORS.normal;
    highlight.style.outline = "2px solid " + c.solid;
    highlight.style.background = c.bg;
    badge.style.background = c.solid;
  };

  var lastSection = null;
  var lastLabel = "";
  var lastKind = "normal";
  var rafPending = false;

  // Document-relative coordinates (rect + scroll) on absolutely-positioned
  // nodes, so the browser scrolls the highlight together with the page
  // natively — no per-frame JS repositioning, no scroll lag.
  var positionHighlight = function(section) {
    var r = section.getBoundingClientRect();
    var top = r.top + window.scrollY;
    var left = r.left + window.scrollX;
    highlight.style.display = "block";
    highlight.style.top = top + "px";
    highlight.style.left = left + "px";
    highlight.style.width = r.width + "px";
    highlight.style.height = r.height + "px";
    badge.textContent = lastLabel || displayKey(section);
    badge.style.display = "block";
    badge.style.top = Math.max(0, top - 20) + "px";
    badge.style.left = left + "px";
  };

  var moveHandler = function(e) {
    if (rafPending) return;
    rafPending = true;
    var target = e.target;
    requestAnimationFrame(function() {
      rafPending = false;
      if (!target || target === highlight || target === badge) return;
      var section = findSection(target);
      if (section === lastSection) return;
      lastSection = section;
      if (!section) {
        highlight.style.display = "none";
        badge.style.display = "none";
        return;
      }
      lastLabel = labelFor(section);
      lastKind = kindFor(section);
      applyColor(lastKind);
      positionHighlight(section);
    });
  };
  document.addEventListener("mousemove", moveHandler, true);

  // Window scroll is handled natively by the absolute positioning above; this
  // only re-syncs on resize and on scrolls inside nested scroll containers
  // (capture=true catches those), where document coordinates do shift.
  var reposition = function() {
    if (!lastSection || highlight.style.display === "none") return;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function() {
      rafPending = false;
      if (lastSection && highlight.style.display !== "none") positionHighlight(lastSection);
    });
  };
  window.addEventListener("scroll", reposition, { capture: true, passive: true });
  window.addEventListener("resize", reposition, { passive: true });

  var outHandler = function(e) {
    if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
      highlight.style.display = "none";
      badge.style.display = "none";
      lastSection = null;
    }
  };
  document.addEventListener("mouseout", outHandler, true);

  var clickHandler = function(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    var target = e.target;
    if (!target || target === highlight || target === badge) return;
    var section = findSection(target);
    if (!section) return;

    var sections = getAllSections();
    var sectionIndex = sections.indexOf(section);
    var manifestKey = section.getAttribute("data-manifest-key") || "";

    var c = COLORS[lastKind] || COLORS.normal;
    highlight.style.outline = "2px solid " + c.solid;
    highlight.style.background = c.active;
    setTimeout(function() {
      highlight.style.background = c.bg;
    }, 400);

    window.parent.postMessage({
      type: "cms-editor::section-clicked",
      payload: { sectionIndex: sectionIndex, manifestKey: manifestKey }
    }, "*");
  };
  document.addEventListener("click", clickHandler, true);

  window.addEventListener("message", function(e) {
    if (e.data && e.data.type === "cms-editor::set-labels" && Array.isArray(e.data.labels)) {
      sectionLabels = e.data.labels;
      if (Array.isArray(e.data.kinds)) sectionKinds = e.data.kinds;
      if (lastSection) {
        lastLabel = labelFor(lastSection);
        lastKind = kindFor(lastSection);
        applyColor(lastKind);
        if (highlight.style.display !== "none") positionHighlight(lastSection);
      }
      return;
    }
    if (e.data && e.data.type === "cms-editor::deactivate") {
      highlight.remove();
      badge.remove();
      document.removeEventListener("mousemove", moveHandler, true);
      document.removeEventListener("mouseout", outHandler, true);
      document.removeEventListener("click", clickHandler, true);
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
      window.__cmsEditorActive = false;
    }
  });
})();`;
