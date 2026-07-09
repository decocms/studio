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

  // Candidate manifest keys per editable section, sent by the editor. Each
  // entry is an array of acceptable DOM keys: [] = wildcard (e.g. multivariate,
  // whose rendered key we can't predict); null = renders NOTHING (hidden
  // section — multivariate whose variants are all gated by never), so the
  // alignment must not consume a DOM node for it; a Lazy lists both its loader
  // key and the inner section's key, since the classic runtime keeps the Lazy
  // wrapper at top level while TanStack renders the inner section directly.
  var sectionCandidates = [];

  // Best in-order assignment of editable sections to DOM sections, maximizing
  // key matches (DP / LCS-style). deco injects framework sections (SEO, Theme,
  // Session, …) that may lead, trail, OR interleave with the editable run; this
  // skips whichever don't match, on any runtime — no hardcoded list. Hidden
  // sections (null candidates) have no DOM node: only visible entries are
  // aligned, then scattered back to their decofile positions (null-filled), so
  // returned indexes still match the decofile array.
  var computeAlignment = function(tops) {
    var visible = [], k;
    for (k = 0; k < sectionCandidates.length; k++) {
      if (sectionCandidates[k] !== null) visible.push(k);
    }
    var N = visible.length, M = tops.length;
    var res = new Array(sectionCandidates.length).fill(null);
    if (!N) return res;
    if (M < N) return tops.slice();
    var domKeys = tops.map(function(s) { return s.getAttribute("data-manifest-key"); });
    var match = function(i, j) {
      var c = sectionCandidates[visible[i]];
      if (!c || !c.length) return 1;
      return c.indexOf(domKeys[j]) >= 0 ? 1 : 0;
    };
    var dp = [], bt = [], i, j;
    for (i = 0; i <= N; i++) { dp.push(new Array(M + 1).fill(0)); bt.push(new Array(M + 1).fill(0)); }
    for (i = 1; i <= N; i++) {
      for (j = i; j <= M; j++) {
        var assign = dp[i - 1][j - 1] + match(i - 1, j - 1);
        var skip = dp[i][j - 1];
        if (j - 1 >= i && skip >= assign) { dp[i][j] = skip; bt[i][j] = 0; }
        else { dp[i][j] = assign; bt[i][j] = 1; }
      }
    }
    i = N; j = M;
    while (i > 0) {
      if (bt[i][j] === 1) { res[visible[i - 1]] = tops[j - 1]; i--; j--; }
      else { j--; }
    }
    return res;
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
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
      window.__cmsEditorActive = false;
    }
  });
})();`;
