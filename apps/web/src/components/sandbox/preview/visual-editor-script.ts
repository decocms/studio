import { z } from "zod";

/**
 * Payload posted from the iframe to the parent via postMessage
 * when the user clicks an element in visual editor mode.
 */
export const VisualEditorPayloadSchema = z.object({
  tag: z.string(),
  id: z.string(),
  classes: z.string(),
  text: z.string(),
  html: z.string(),
  manifestKey: z.string().nullable(),
  componentName: z.string().nullable(),
  parents: z.string(),
  url: z.string(),
  path: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  position: z.object({ x: z.number(), y: z.number() }),
});

export type VisualEditorPayload = z.infer<typeof VisualEditorPayloadSchema>;

/**
 * Self-contained script string for injection into the preview iframe.
 * Stored as a string constant (not .toString()) to survive minification.
 *
 * Key design decisions:
 * - Uses `mousemove` (not `mouseover`) — fires once per position, gives correct target
 * - rAF-throttled highlight — avoids layout thrashing
 * - No CSS transition on highlight — rAF already provides smooth updates; transitions
 *   on top/left would trigger redundant layout passes
 * - Posts to "*" target origin — the iframe can't know the parent origin reliably;
 *   origin validation happens on the receiving (parent) side
 * - Strips value attributes from captured HTML to avoid leaking form data
 * - ~2.5KB unminified — keep it small since it's inlined in the JS bundle
 */
export const VISUAL_EDITOR_SCRIPT = `(function() {
  if (window.__visualEditorActive) return;
  window.__visualEditorActive = true;

  var cursorStyle = document.createElement("style");
  cursorStyle.textContent = "* { cursor: default !important; }";
  document.head.appendChild(cursorStyle);

  var highlight = document.createElement("div");
  highlight.style.cssText = "position:fixed;pointer-events:none;outline:2px solid #a855f7;background:rgba(168,85,247,0.08);border-radius:2px;z-index:2147483647;display:none;";
  document.body.appendChild(highlight);

  var badge = document.createElement("div");
  badge.style.cssText = "position:fixed;pointer-events:none;background:#a855f7;color:white;font:11px/1 monospace;padding:2px 6px;border-radius:2px;z-index:2147483647;display:none;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;";
  document.body.appendChild(badge);

  var lastTarget = null;
  var rafPending = false;
  var moveHandler = function(e) {
    if (rafPending) return;
    rafPending = true;
    var target = e.target;
    requestAnimationFrame(function() {
      rafPending = false;
      var el = target;
      if (!el || el === highlight || el === badge) return;
      if (el === lastTarget) return;
      lastTarget = el;
      var r = el.getBoundingClientRect();
      highlight.style.display = "block";
      highlight.style.top = r.top + "px";
      highlight.style.left = r.left + "px";
      highlight.style.width = r.width + "px";
      highlight.style.height = r.height + "px";
      var tag = el.tagName.toLowerCase();
      var id = el.id ? "#" + el.id : "";
      var cls = el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".")
        : "";
      badge.textContent = tag + id + cls;
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
      lastTarget = null;
    }
  };
  document.addEventListener("mouseout", outHandler, true);

  var clickHandler = function(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    var el = e.target;
    if (!el || el === highlight || el === badge) return;

    highlight.style.outline = "2px solid #a855f7";
    highlight.style.background = "rgba(168,85,247,0.15)";
    setTimeout(function() {
      highlight.style.outline = "2px solid #a855f7";
      highlight.style.background = "rgba(168,85,247,0.08)";
    }, 400);

    var tag = el.tagName.toLowerCase();
    var id = el.id || "";
    var classes = el.className && typeof el.className === "string" ? el.className.trim() : "";
    var text = (el.textContent || "").trim().slice(0, 200);
    var html = (el.outerHTML || "").slice(0, 800).replace(/\\svalue=("[^"]*"|'[^']*'|\\S+)/gi, "");

    var closestSection = el.closest("section[data-manifest-key]");
    var manifestKey = closestSection ? closestSection.getAttribute("data-manifest-key") : null;

    var ancestor = el;
    var componentName = null;
    for (var i = 0; i < 10 && ancestor; i++) {
      if (ancestor.dataset) componentName = ancestor.dataset.componentName || componentName;
      ancestor = ancestor.parentElement;
    }

    var parents = [];
    var p = el.parentElement;
    for (var j = 0; j < 4 && p && p !== document.body; j++) {
      var pTag = p.tagName ? p.tagName.toLowerCase() : "";
      var pId = p.id ? "#" + p.id : "";
      var pCls = p.className && typeof p.className === "string"
        ? "." + p.className.trim().split(/\\s+/)[0]
        : "";
      parents.unshift(pTag + pId + pCls);
      p = p.parentElement;
    }

    window.parent.postMessage({
      type: "visual-editor::element-clicked",
      payload: {
        tag: tag, id: id, classes: classes, text: text, html: html,
        manifestKey: manifestKey, componentName: componentName,
        parents: parents.join(" > "),
        url: window.location.href, path: window.location.pathname,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        position: { x: Math.round(e.clientX), y: Math.round(e.clientY) }
      }
    }, "*");
  };
  document.addEventListener("click", clickHandler, true);

  window.addEventListener("message", function(e) {
    if (e.data && e.data.type === "visual-editor::deactivate") {
      highlight.remove();
      badge.remove();
      cursorStyle.remove();
      document.removeEventListener("mousemove", moveHandler, true);
      document.removeEventListener("mouseout", outHandler, true);
      document.removeEventListener("click", clickHandler, true);
      window.__visualEditorActive = false;
    }
  });
})();`;
