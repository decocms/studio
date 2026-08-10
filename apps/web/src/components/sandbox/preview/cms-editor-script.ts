import { z } from "zod";
import { alignSections } from "./section-alignment";

export const CmsEditorPayloadSchema = z.object({
  sectionIndex: z.number(),
  manifestKey: z.string(),
  /** Monotonic per-click counter: two clicks on one section are two selections. */
  clickSeq: z.number(),
});

export type CmsEditorPayload = z.infer<typeof CmsEditorPayloadSchema>;

/**
 * Self-contained script injected into the preview iframe for CMS mode.
 * Highlights full page sections (top-level <section data-manifest-key>) on
 * hover and posts the section's index — matching the decofile sections array —
 * back to the parent on click.
 *
 * deco injects framework sections (SEO, Theme, Analytics, …) around the page's
 * editable sections, so the DOM has more top-level sections than the decofile
 * array. Rather than hardcoding which to skip, the editor sends the expected
 * manifest-key sequence of the editable run and we align it within the DOM
 * (see set-labels handler), so any leading/trailing framework sections drop out
 * automatically.
 */
export const CMS_EDITOR_SCRIPT = `(function() {
  if (window.__cmsEditorActive) return;
  window.__cmsEditorActive = true;

  // Preserve scroll across variant-override navigations and save-reloads.
  // Selecting a variant rebuilds the iframe src (new x-deco-matchers-override)
  // or reloads it, which would otherwise jump to the top. We persist the scroll
  // offset to sessionStorage (survives reload, same-origin) keyed by pathname
  // (the override only changes the query, so the key is stable), then restore it
  // on the next load — retried for ~1s so it outlasts re-hydration and lazy
  // sections that grow the page after load. The recency guard avoids restoring a
  // stale offset on a genuinely fresh visit.
  var SCROLL_KEY = "__cms_preview_scroll:" + location.pathname;
  var saveScroll = function() {
    try {
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({
        x: window.scrollX, y: window.scrollY, t: Date.now()
      }));
    } catch (_) {}
  };
  var saveScrollPending = false;
  window.addEventListener("scroll", function() {
    if (saveScrollPending) return;
    saveScrollPending = true;
    requestAnimationFrame(function() { saveScrollPending = false; saveScroll(); });
  }, { passive: true });
  (function restoreScroll() {
    var raw = null;
    try { raw = sessionStorage.getItem(SCROLL_KEY); } catch (_) {}
    if (!raw) return;
    var saved = null;
    try { saved = JSON.parse(raw); } catch (_) { return; }
    if (!saved || (Date.now() - saved.t) > 10000) return;
    if (!saved.x && !saved.y) return;
    var attempts = 0;
    var apply = function() {
      attempts++;
      window.scrollTo(saved.x || 0, saved.y || 0);
      if (attempts < 8) setTimeout(apply, 120);
    };
    apply();
  })();

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

  // All top-level page sections in DOM order (deco renders page sections as
  // <section data-manifest-key>; nested islands/sections carry the attribute
  // too, hence the top-level filter). This is the full DOM run, framework
  // sections included — getAllSections() narrows it to the editable window.
  var topLevelSections = function() {
    return Array.from(document.querySelectorAll("section[data-manifest-key]"))
      .filter(isTopLevelSection);
  };

  // Acceptable DOM keys per section; [] = wildcard, null = renders nothing.
  var sectionCandidates = [];

  // Stringified from section-alignment.ts so both sides share one copy.
  var alignSections = ${alignSections.toString()};

  // Indexed like the decofile array; unmapped entries stay null (not clickable).
  var computeAlignment = function(tops) {
    var domKeys = tops.map(function(s) { return s.getAttribute("data-manifest-key"); });
    return alignSections(sectionCandidates, domKeys).map(function(idx) {
      return idx === null ? null : tops[idx];
    });
  };

  // Editable sections, indexed to match the decofile array the panel uses.
  // Recomputed from the live DOM each call (cheap, rAF-throttled) so it
  // self-heals as client-rendered/lazy sections mount. Until the editor sends
  // candidates, fall back to the full top-level run.
  var getAllSections = function() {
    var tops = topLevelSections();
    return sectionCandidates.length ? computeAlignment(tops) : tops;
  };

  // Resolve to the OUTERMOST page-level section (clicking nested content still
  // maps to the top-level section the panel indexes); null if it isn't in the
  // aligned editable set (a framework section deco injected).
  var findSection = function(el) {
    var node = el;
    var found = null;
    while (node && node !== document.body) {
      if (node.tagName === "SECTION" && node.hasAttribute && node.hasAttribute("data-manifest-key")) {
        found = node;
      }
      node = node.parentElement;
    }
    if (!found) return null;
    return getAllSections().indexOf(found) >= 0 ? found : null;
  };

  // A Lazy wrapper's key is just the loader — show the inner section's instead.
  var LAZY_KEYS = [
    "website/sections/Rendering/Lazy.tsx",
    "website/sections/Rendering/SingleDeferred.tsx"
  ];
  var isLazyKey = function(key) {
    return LAZY_KEYS.some(function(s) { return key.endsWith(s); });
  };
  var displayKey = function(section) {
    var key = section.getAttribute("data-manifest-key") || "section";
    if (isLazyKey(key)) {
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

  var clickSeq = 0;

  // Blocks observes clicks to select sections in the side panel; it must not
  // cancel the iframe page's own handlers or native control behavior.
  var clickHandler = function(e) {
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

    clickSeq++;
    window.parent.postMessage({
      type: "cms-editor::section-clicked",
      payload: { sectionIndex: sectionIndex, manifestKey: manifestKey, clickSeq: clickSeq }
    }, "*");
  };
  document.addEventListener("click", clickHandler, true);

  /**
   * Navigation is disabled while editing: leaving the page would leave the
   * panel editing the previous page's sections. Only the default action of a
   * real navigation is cancelled, never propagation — in-page controls must
   * keep working (#5567).
   */
  var isNavigatingAnchor = function(a) {
    if (!a) return false;
    var href = a.getAttribute("href");
    if (!href) return false;
    var trimmed = href.trim();
    if (!trimmed || trimmed.charAt(0) === "#") return false;
    if (/^javascript:/i.test(trimmed)) return false;
    // Same document + fragment only scrolls.
    try {
      var url = new URL(a.href, location.href);
      if (url.href.split("#")[0] === location.href.split("#")[0]) return false;
    } catch (_) {}
    return true;
  };
  var navBlocker = function(e) {
    var el = e.target;
    var a = el && el.closest ? el.closest("a") : null;
    if (!isNavigatingAnchor(a)) return;
    e.preventDefault();
  };
  document.addEventListener("click", navBlocker, true);

  var submitBlocker = function(e) { e.preventDefault(); };
  document.addEventListener("submit", submitBlocker, true);

  window.addEventListener("message", function(e) {
    if (e.data && e.data.type === "cms-editor::set-labels" && Array.isArray(e.data.labels)) {
      sectionLabels = e.data.labels;
      if (Array.isArray(e.data.kinds)) sectionKinds = e.data.kinds;
      if (Array.isArray(e.data.keys)) sectionCandidates = e.data.keys;
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
      // Or the page stays unnavigable after leaving Blocks mode.
      document.removeEventListener("click", navBlocker, true);
      document.removeEventListener("submit", submitBlocker, true);
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
      window.__cmsEditorActive = false;
    }
  });
})();`;
