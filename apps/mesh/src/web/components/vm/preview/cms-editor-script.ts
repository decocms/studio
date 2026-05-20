import { z } from "zod";

export const CmsEditorPayloadSchema = z.object({
  sectionIndex: z.number(),
  manifestKey: z.string(),
});

export type CmsEditorPayload = z.infer<typeof CmsEditorPayloadSchema>;

/**
 * Self-contained script injected into the preview iframe for CMS mode.
 * Highlights full sections (elements with data-manifest-key) on hover
 * and posts the section's DOM index back to the parent on click.
 */
export const CMS_EDITOR_SCRIPT = `(function() {
  if (window.__cmsEditorActive) return;
  window.__cmsEditorActive = true;

  var highlight = document.createElement("div");
  highlight.style.cssText = "position:fixed;pointer-events:none;outline:2px solid #06b6d4;background:rgba(6,182,212,0.06);border-radius:2px;z-index:2147483647;display:none;";
  document.body.appendChild(highlight);

  var badge = document.createElement("div");
  badge.style.cssText = "position:fixed;pointer-events:none;background:#06b6d4;color:white;font:11px/1 monospace;padding:2px 6px;border-radius:2px;z-index:2147483647;display:none;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;";
  document.body.appendChild(badge);

  var findSection = function(el) {
    var node = el;
    while (node && node !== document.body) {
      if (node.hasAttribute && node.hasAttribute("data-manifest-key")) return node;
      node = node.parentElement;
    }
    return null;
  };

  var getAllSections = function() {
    return Array.from(document.querySelectorAll("[data-manifest-key]"));
  };

  var lastSection = null;
  var rafPending = false;

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
      var r = section.getBoundingClientRect();
      highlight.style.display = "block";
      highlight.style.top = r.top + "px";
      highlight.style.left = r.left + "px";
      highlight.style.width = r.width + "px";
      highlight.style.height = r.height + "px";
      badge.textContent = section.getAttribute("data-manifest-key") || "section";
      badge.style.display = "block";
      badge.style.top = Math.max(0, r.top - 20) + "px";
      badge.style.left = r.left + "px";
    });
  };
  document.addEventListener("mousemove", moveHandler, true);

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

    highlight.style.outline = "2px solid #06b6d4";
    highlight.style.background = "rgba(6,182,212,0.18)";
    setTimeout(function() {
      highlight.style.background = "rgba(6,182,212,0.06)";
    }, 400);

    window.parent.postMessage({
      type: "cms-editor::section-clicked",
      payload: { sectionIndex: sectionIndex, manifestKey: manifestKey }
    }, "*");
  };
  document.addEventListener("click", clickHandler, true);

  window.addEventListener("message", function(e) {
    if (e.data && e.data.type === "cms-editor::deactivate") {
      highlight.remove();
      badge.remove();
      document.removeEventListener("mousemove", moveHandler, true);
      document.removeEventListener("mouseout", outHandler, true);
      document.removeEventListener("click", clickHandler, true);
      window.__cmsEditorActive = false;
    }
  });
})();`;
