/**
 * <deck-viewer> — Studio's presentation deck runtime (v1).
 *
 * A deck is a single self-contained HTML file: a theme <style> in <head>,
 * this script (classic, non-module — loaded no-cors so it works from the
 * sandboxed preview iframe), and one <deck-viewer> element whose direct
 * <section> children are the slides.
 *
 *   <deck-viewer width="1920" height="1080">
 *     <section>…</section>
 *     <section>…</section>
 *   </deck-viewer>
 *   <script src="/deck-runtime/v1/deck-viewer.js"></script>
 *
 * Features:
 *  - Fixed design canvas (default 1920×1080) scaled with transform:scale()
 *    to fit the viewport, letterboxed.
 *  - Keyboard nav (←/→, PgUp/PgDn, Space, Home/End, digits, R), tap-halves
 *    nav on touch, bottom-center overlay with prev/count/next/reset.
 *  - Thumbnail rail (left column of static scaled clones); click to
 *    navigate, drag to reorder, right-click for Skip / Move / Duplicate /
 *    Delete — structural ops are only enabled in edit mode.
 *  - Edit mode (host-toggled): slides become contenteditable; text edits
 *    and structural ops self-apply optimistically AND are posted to the
 *    parent window, which persists them to the source file.
 *  - Print: one page per slide at design size (@page rule injected into
 *    document head — @page is a no-op inside shadow DOM). Open with a
 *    #print fragment to auto-trigger window.print() (PDF export path).
 *
 * postMessage protocol (v1) — all messages carry `v: 1`. The document may
 * run in an opaque-origin sandboxed iframe, so both directions post with
 * targetOrigin "*" and the parent validates event.source identity.
 *
 * runtime → parent:
 *   { v, source: "deck-viewer", type: "ready", total, design: {width, height} }
 *   { v, source: "deck-viewer", type: "state", index, total, skipped: number[] }
 *   { v, source: "deck-viewer", type: "op", opId, witness: { childCount }, op }
 *     op: { kind: "move", from, to } | { kind: "remove", at }
 *       | { kind: "duplicate", at }
 *       | { kind: "set-attr", at, name, value } | { kind: "remove-attr", at, name }
 *       | { kind: "replace", at, html }   // contenteditable edit; cleaned outerHTML
 *
 * parent → runtime:
 *   { v, type: "ack", opId, ok, error? }
 *   { v, type: "set-edit-mode", enabled }
 *   { v, type: "goto", index }
 *   { v, type: "print" }
 *
 * Slide indices are positions in the light-DOM section list (including
 * skipped slides) at the moment the op was emitted.
 */

(() => {
  const PROTOCOL_V = 1;
  const DESIGN_W_DEFAULT = 1920;
  const DESIGN_H_DEFAULT = 1080;
  const OVERLAY_HIDE_MS = 1800;
  const ACK_TIMEOUT_MS = 5000;
  const TEXT_EDIT_DEBOUNCE_MS = 800;
  const RAIL_DEFAULT_W = 168;
  const FINE_POINTER_MQ = matchMedia("(hover: hover) and (pointer: fine)");
  const NARROW_MQ = matchMedia("(max-width: 640px)");
  // Slide-authored controls that should keep a tap instead of navigating.
  const INTERACTIVE_SEL =
    'a[href], button, input, select, textarea, summary, label, video[controls], audio[controls], [role="button"], [onclick]';
  // Attributes this runtime writes onto slides; stripped before any HTML
  // leaves the component (replace ops, duplicate clones) so the persisted
  // file stays clean.
  const RUNTIME_ATTRS = [
    "contenteditable",
    "spellcheck",
    "tabindex",
    "aria-hidden",
    "data-deck-active",
    "data-deck-last-visible",
  ];

  const stylesheet = `
    :host {
      position: fixed;
      inset: 0;
      display: block;
      background: #111;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      overflow: hidden;
      -webkit-tap-highlight-color: transparent;
    }

    .stage {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .canvas {
      position: relative;
      transform-origin: center center;
      flex-shrink: 0;
      background: #fff;
      will-change: transform;
    }

    /* Slides live in light DOM (via <slot>) so authored CSS applies. Every
       slotted child is absolutely positioned to stack; only the active one
       is visible. Hidden, not unmounted — slide state survives nav. */
    ::slotted(*) {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      box-sizing: border-box !important;
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
      visibility: hidden;
    }
    ::slotted([data-deck-active]) {
      opacity: 1;
      pointer-events: auto;
      visibility: visible;
    }

    .overlay {
      position: fixed;
      left: 50%;
      bottom: 20px;
      transform: translate(-50%, 6px);
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px;
      background: rgba(0, 0, 0, 0.92);
      color: #fff;
      border-radius: 999px;
      font-size: 12px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 200ms ease, transform 200ms ease;
      z-index: 100;
      user-select: none;
    }
    .overlay[data-visible] {
      opacity: 1;
      pointer-events: auto;
      transform: translate(-50%, 0);
    }
    .btn {
      appearance: none;
      background: transparent;
      border: 0;
      margin: 0;
      padding: 0;
      color: rgba(255, 255, 255, 0.75);
      font: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 28px;
      min-width: 28px;
      border-radius: 999px;
      cursor: pointer;
    }
    .btn:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
    .btn svg { width: 14px; height: 14px; display: block; }
    .count {
      font-variant-numeric: tabular-nums;
      padding: 0 8px;
      min-width: 44px;
      text-align: center;
    }
    .count .total { color: rgba(255, 255, 255, 0.55); }

    /* ── Thumbnail rail ─────────────────────────────────────────────── */
    .rail {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      width: var(--deck-rail-w, ${RAIL_DEFAULT_W}px);
      background: #1a1a1a;
      border-right: 1px solid rgba(255, 255, 255, 0.08);
      overflow-y: auto;
      overflow-x: hidden;
      padding: 12px 10px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 12px;
      z-index: 50;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
    }
    /* The rail is presentation chrome — hidden by default (a deck opened
       in a fresh tab is presentation-first). The 'rail' URL-hash token or
       the host's set-rail message opens it (data-rail-open). */
    .rail, .rail-resize { display: none; }
    :host([data-rail-open]) .rail { display: flex; }
    :host([data-rail-open]) .rail-resize { display: block; }
    :host([no-rail]) .rail, :host([no-rail]) .rail-resize { display: none !important; }
    @media (max-width: 640px) {
      .rail, .rail-resize { display: none !important; }
    }
    .thumb {
      position: relative;
      display: flex;
      align-items: flex-start;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      outline: none;
    }
    .thumb .num {
      width: 16px;
      flex-shrink: 0;
      font-size: 11px;
      text-align: right;
      color: rgba(255, 255, 255, 0.55);
      padding-top: 2px;
      font-variant-numeric: tabular-nums;
    }
    .thumb .frame {
      position: relative;
      flex: 1;
      min-width: 0;
      aspect-ratio: var(--deck-aspect, 16 / 9);
      background: #fff;
      border-radius: 4px;
      outline: 2px solid transparent;
      overflow: hidden;
      transition: outline-color 120ms ease;
    }
    .thumb:hover .frame { outline-color: rgba(255, 255, 255, 0.25); }
    .thumb[data-current] .num { color: #fff; }
    .thumb[data-current] .frame { outline-color: #6e8bff; }
    .thumb[data-dragging] { opacity: 0.35; }
    .thumb::before {
      content: "";
      position: absolute;
      left: 24px;
      right: 0;
      height: 3px;
      border-radius: 2px;
      background: #6e8bff;
      opacity: 0;
      pointer-events: none;
    }
    .thumb[data-drop="before"]::before { top: -8px; opacity: 1; }
    .thumb[data-drop="after"]::before { bottom: -8px; opacity: 1; }
    .thumb[data-skip] .frame { opacity: 0.35; }
    .thumb[data-skip] .frame::after {
      content: "Skipped";
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
      color: #fff;
      font-size: 10px;
      letter-spacing: 0.04em;
    }
    .rail-resize {
      position: fixed;
      left: calc(var(--deck-rail-w, ${RAIL_DEFAULT_W}px) - 3px);
      top: 0;
      bottom: 0;
      width: 6px;
      cursor: col-resize;
      z-index: 60;
      touch-action: none;
    }
    .rail-resize:hover, .rail-resize[data-dragging] { background: rgba(255, 255, 255, 0.12); }

    .ctxmenu {
      position: fixed;
      min-width: 150px;
      padding: 4px;
      background: #242424;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 7px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      z-index: 120;
      display: none;
      font-size: 12px;
    }
    .ctxmenu[data-open] { display: block; }
    .ctxmenu button {
      display: block;
      width: 100%;
      appearance: none;
      border: 0;
      background: transparent;
      color: #e8e8e8;
      font: inherit;
      text-align: left;
      padding: 6px 10px;
      border-radius: 4px;
      cursor: pointer;
    }
    .ctxmenu button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); }
    .ctxmenu button:disabled { opacity: 0.35; cursor: default; }
    .ctxmenu hr { border: 0; border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 4px 2px; }

    .confirm-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      z-index: 130;
      display: none;
      align-items: center;
      justify-content: center;
    }
    .confirm-backdrop[data-open] { display: flex; }
    .confirm {
      width: 300px;
      max-width: calc(100vw - 32px);
      background: #2a2a2a;
      color: #e8e8e8;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      overflow: hidden;
    }
    .confirm .body { padding: 18px 18px 14px; }
    .confirm .title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
    .confirm .msg { font-size: 13px; line-height: 1.5; color: rgba(255, 255, 255, 0.65); }
    .confirm .footer {
      padding: 12px 18px;
      background: #1f1f1f;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .confirm button {
      appearance: none;
      font: inherit;
      font-size: 13px;
      padding: 7px 14px;
      border-radius: 8px;
      cursor: pointer;
      border: 0;
    }
    .confirm .cancel { background: transparent; color: rgba(255, 255, 255, 0.8); }
    .confirm .cancel:hover { background: rgba(255, 255, 255, 0.08); }
    .confirm .danger { background: #c0442c; color: #fff; }
    .confirm .danger:hover { background: #ad3c26; }

    .toast {
      position: fixed;
      left: 50%;
      bottom: 64px;
      transform: translateX(-50%);
      background: #c0442c;
      color: #fff;
      font-size: 12px;
      padding: 8px 14px;
      border-radius: 8px;
      z-index: 140;
      opacity: 0;
      pointer-events: none;
      transition: opacity 200ms ease;
    }
    .toast[data-visible] { opacity: 1; }

    /* Edit-mode affordance: a subtle outline on the hovered/focused slide. */
    :host([data-edit-mode]) ::slotted([data-deck-active]) {
      outline: 1px dashed rgba(110, 139, 255, 0.5);
      outline-offset: -1px;
    }

    /* ── Print: one page per slide, no chrome ───────────────────────────
       Screen layout stacks slides inside a scaled canvas; for print they
       go into document flow at the authored design size so the browser
       paginates one slide per sheet. The @page rule is injected into
       document <head> (no effect inside shadow DOM). */
    @media print {
      :host {
        position: static;
        inset: auto;
        background: none;
        overflow: visible;
        color: inherit;
      }
      .stage { position: static; display: block; }
      .canvas {
        transform: none !important;
        width: auto !important;
        height: auto !important;
        background: none;
        will-change: auto;
      }
      ::slotted(*) {
        position: relative !important;
        inset: auto !important;
        width: var(--deck-design-w) !important;
        height: var(--deck-design-h) !important;
        box-sizing: border-box !important;
        opacity: 1 !important;
        visibility: visible !important;
        pointer-events: auto;
        break-after: page;
        page-break-after: always;
        break-inside: avoid;
        overflow: hidden;
      }
      /* The last *visible* slide must not force a trailing blank page —
         :last-child alone misses the case where trailing slides are
         skipped. _markLastVisible() maintains the attribute. */
      ::slotted(*:last-child),
      ::slotted([data-deck-last-visible]) {
        break-after: auto;
        page-break-after: auto;
      }
      ::slotted([data-deck-skip]) { display: none !important; }
      .overlay, .rail, .rail-resize, .ctxmenu, .confirm-backdrop, .toast {
        display: none !important;
      }
    }
  `;

  class DeckViewer extends HTMLElement {
    static get observedAttributes() {
      return ["width", "height", "no-rail"];
    }

    constructor() {
      super();
      this._root = this.attachShadow({ mode: "open" });
      this._index = 0;
      this._slides = [];
      this._thumbs = [];
      this._editMode = false;
      this._railOpen = false;
      this._opSeq = 0;
      this._pendingAcks = new Map();
      this._railLocked = false;
      this._menuIndex = -1;
      this._confirmIndex = -1;
      this._dragFrom = null;
      this._dropOn = null;
      this._hideTimer = null;
      this._printed = false;

      this._onKey = this._onKey.bind(this);
      this._onResize = this._onResize.bind(this);
      this._onMessage = this._onMessage.bind(this);
      this._onMouseMove = this._onMouseMove.bind(this);
      this._onTap = this._onTap.bind(this);
      this._onHashChange = this._onHashChange.bind(this);
      this._onBeforePrint = this._onBeforePrint.bind(this);
      this._onAfterPrint = this._onAfterPrint.bind(this);
      this._onFocusIn = this._onFocusIn.bind(this);
      this._onFocusOut = this._onFocusOut.bind(this);
      this._onInput = this._onInput.bind(this);
      this._onDocClick = (e) => {
        if (this._menu && e.composedPath().includes(this._menu)) return;
        this._closeMenu();
      };
    }

    get designWidth() {
      return parseInt(this.getAttribute("width"), 10) || DESIGN_W_DEFAULT;
    }
    get designHeight() {
      return parseInt(this.getAttribute("height"), 10) || DESIGN_H_DEFAULT;
    }

    connectedCallback() {
      this._render();
      this._syncPrintPageRule();
      window.addEventListener("keydown", this._onKey);
      window.addEventListener("resize", this._onResize);
      window.addEventListener("message", this._onMessage);
      window.addEventListener("mousemove", this._onMouseMove, {
        passive: true,
      });
      window.addEventListener("hashchange", this._onHashChange);
      window.addEventListener("beforeprint", this._onBeforePrint);
      window.addEventListener("afterprint", this._onAfterPrint);
      window.addEventListener("click", this._onDocClick, true);
      this.addEventListener("click", this._onTap);
      this.addEventListener("focusin", this._onFocusIn);
      this.addEventListener("focusout", this._onFocusOut);
      this.addEventListener("input", this._onInput);
      // Initial slide collection happens via slotchange (fires on mount).
      this._maybeAutoPrint();
    }

    disconnectedCallback() {
      window.removeEventListener("keydown", this._onKey);
      window.removeEventListener("resize", this._onResize);
      window.removeEventListener("message", this._onMessage);
      window.removeEventListener("mousemove", this._onMouseMove);
      window.removeEventListener("hashchange", this._onHashChange);
      window.removeEventListener("beforeprint", this._onBeforePrint);
      window.removeEventListener("afterprint", this._onAfterPrint);
      window.removeEventListener("click", this._onDocClick, true);
      this.removeEventListener("click", this._onTap);
      this.removeEventListener("focusin", this._onFocusIn);
      this.removeEventListener("focusout", this._onFocusOut);
      this.removeEventListener("input", this._onInput);
      if (this._hideTimer) clearTimeout(this._hideTimer);
      if (this._textDebounce) clearTimeout(this._textDebounce);
      this._pendingAcks.forEach((p) => clearTimeout(p.timer));
      this._pendingAcks.clear();
    }

    attributeChangedCallback() {
      if (!this._canvas) return;
      this._applyDesignSize();
      this._fit();
      this._scaleThumbs();
      this._syncPrintPageRule();
    }

    // ── Rendering ─────────────────────────────────────────────────────

    _render() {
      const style = document.createElement("style");
      style.textContent = stylesheet;

      const stage = document.createElement("div");
      stage.className = "stage";
      const canvas = document.createElement("div");
      canvas.className = "canvas";
      const slot = document.createElement("slot");
      slot.addEventListener("slotchange", () => this._onSlotChange());
      canvas.appendChild(slot);
      stage.appendChild(canvas);

      const overlay = document.createElement("div");
      overlay.className = "overlay";
      overlay.setAttribute("role", "toolbar");
      overlay.setAttribute("aria-label", "Deck controls");
      overlay.innerHTML = `
        <button class="btn prev" type="button" aria-label="Previous slide" title="Previous (←)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>
        </button>
        <span class="count" aria-live="polite"><span class="current">1</span><span class="total"> / 1</span></span>
        <button class="btn next" type="button" aria-label="Next slide" title="Next (→)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>
        </button>
      `;
      overlay
        .querySelector(".prev")
        .addEventListener("click", () => this._advance(-1));
      overlay
        .querySelector(".next")
        .addEventListener("click", () => this._advance(1));

      const rail = document.createElement("div");
      rail.className = "rail";

      const resize = document.createElement("div");
      resize.className = "rail-resize";
      resize.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        resize.setPointerCapture(e.pointerId);
        resize.setAttribute("data-dragging", "");
        const move = (ev) => this._setRailWidth(ev.clientX);
        const up = () => {
          resize.removeEventListener("pointermove", move);
          resize.removeEventListener("pointerup", up);
          resize.removeEventListener("pointercancel", up);
          resize.removeAttribute("data-dragging");
          try {
            localStorage.setItem("deck-viewer.railWidth", String(this._railPx));
          } catch {
            /* opaque origin */
          }
        };
        resize.addEventListener("pointermove", move);
        resize.addEventListener("pointerup", up);
        resize.addEventListener("pointercancel", up);
      });

      const menu = document.createElement("div");
      menu.className = "ctxmenu";
      menu.innerHTML = `
        <button type="button" data-act="skip">Skip slide</button>
        <button type="button" data-act="up">Move up</button>
        <button type="button" data-act="down">Move down</button>
        <button type="button" data-act="duplicate">Duplicate slide</button>
        <hr>
        <button type="button" data-act="delete">Delete slide</button>
      `;
      menu.addEventListener("click", (e) => {
        const act =
          e.target instanceof Element && e.target.getAttribute("data-act");
        if (!act) return;
        const i = this._menuIndex;
        this._closeMenu();
        if (act === "skip") this._toggleSkip(i);
        else if (act === "up") this._moveSlide(i, i - 1);
        else if (act === "down") this._moveSlide(i, i + 1);
        else if (act === "duplicate") this._duplicateSlide(i);
        else if (act === "delete") this._openConfirm(i);
      });
      menu.addEventListener("contextmenu", (e) => e.preventDefault());

      const confirm = document.createElement("div");
      confirm.className = "confirm-backdrop";
      confirm.innerHTML = `
        <div class="confirm" role="dialog" aria-modal="true">
          <div class="body">
            <div class="title">Delete slide?</div>
            <div class="msg">This slide will be removed from the deck.</div>
          </div>
          <div class="footer">
            <button type="button" class="cancel">Cancel</button>
            <button type="button" class="danger">Delete</button>
          </div>
        </div>
      `;
      confirm.addEventListener("click", (e) => {
        if (e.target === confirm) this._closeConfirm();
      });
      confirm
        .querySelector(".cancel")
        .addEventListener("click", () => this._closeConfirm());
      confirm.querySelector(".danger").addEventListener("click", () => {
        const i = this._confirmIndex;
        this._closeConfirm();
        this._deleteSlide(i);
      });

      const toast = document.createElement("div");
      toast.className = "toast";

      this._root.append(
        style,
        rail,
        resize,
        stage,
        overlay,
        menu,
        confirm,
        toast,
      );
      this._canvas = canvas;
      this._stage = stage;
      this._overlay = overlay;
      this._rail = rail;
      this._menu = menu;
      this._confirm = confirm;
      this._toast = toast;
      this._countEl = overlay.querySelector(".current");
      this._totalEl = overlay.querySelector(".total");

      this._applyDesignSize();
      let rw = RAIL_DEFAULT_W;
      try {
        const s = localStorage.getItem("deck-viewer.railWidth");
        if (s) rw = parseInt(s, 10) || rw;
      } catch {
        /* opaque origin */
      }
      this._setRailWidth(rw);
    }

    _applyDesignSize() {
      this._canvas.style.width = `${this.designWidth}px`;
      this._canvas.style.height = `${this.designHeight}px`;
      this._canvas.style.setProperty(
        "--deck-design-w",
        `${this.designWidth}px`,
      );
      this._canvas.style.setProperty(
        "--deck-design-h",
        `${this.designHeight}px`,
      );
      if (this._rail) {
        this._rail.style.setProperty(
          "--deck-aspect",
          `${this.designWidth} / ${this.designHeight}`,
        );
      }
    }

    _setRailWidth(px) {
      const w = Math.max(110, Math.min(340, Math.round(px)));
      this._railPx = w;
      this.style.setProperty("--deck-rail-w", `${w}px`);
      this._fit();
      if (!this._scaleRaf) {
        this._scaleRaf = requestAnimationFrame(() => {
          this._scaleRaf = null;
          this._scaleThumbs();
        });
      }
    }

    /** @page must live in the document stylesheet — it's a no-op inside
     *  shadow DOM. One injected <head> style tag makes Print → Save as PDF
     *  yield one slide per page at design size with no margins. */
    _syncPrintPageRule() {
      const id = "deck-viewer-print-page";
      let tag = document.getElementById(id);
      if (!tag) {
        tag = document.createElement("style");
        tag.id = id;
        document.head.appendChild(tag);
      }
      tag.textContent =
        `@page { size: ${this.designWidth}px ${this.designHeight}px; margin: 0; } ` +
        "@media print { html, body { margin: 0 !important; padding: 0 !important; " +
        "background: none !important; overflow: visible !important; height: auto !important; } " +
        "* { -webkit-print-color-adjust: exact; print-color-adjust: exact; } " +
        // Jump animations/transitions to their end state so print never
        // captures a mid-entrance frame — pairs with the beforeprint
        // handler that marks every slide active.
        "*, *::before, *::after { animation-delay: -99s !important; " +
        "animation-duration: 0.001s !important; animation-iteration-count: 1 !important; " +
        "animation-fill-mode: both !important; transition-duration: 0s !important; } }";
    }

    // ── Slide collection & navigation ─────────────────────────────────

    _onSlotChange() {
      this._collectSlides();
      // Deep-link hash applies only on the initial collection — later
      // slotchanges come from structural edits that already adjusted
      // _index, and the stale hash must not override them.
      if (!this._readySent) this._applyHash({ initial: true });
      this._applyIndex({ showOverlay: false });
      this._fit();
      if (!this._readySent) {
        this._readySent = true;
        this._post({
          type: "ready",
          total: this._slides.length,
          design: { width: this.designWidth, height: this.designHeight },
        });
      }
    }

    _collectSlides() {
      const assigned = this._root
        .querySelector("slot")
        .assignedElements({ flatten: true });
      this._slides = assigned.filter(
        (el) => !/^(TEMPLATE|SCRIPT|STYLE)$/.test(el.tagName),
      );
      if (this._index >= this._slides.length) {
        this._index = Math.max(0, this._slides.length - 1);
      }
      if (this._totalEl)
        this._totalEl.textContent = ` / ${this._slides.length || 1}`;
      this._markLastVisible();
      this._renderRail();
      this._syncEditable();
    }

    _markLastVisible() {
      let last = null;
      for (const s of this._slides) {
        s.removeAttribute("data-deck-last-visible");
        if (!s.hasAttribute("data-deck-skip")) last = s;
      }
      if (last) last.setAttribute("data-deck-last-visible", "");
    }

    /** Hash grammar: comma/&-separated tokens — a 1-based number is the
     *  slide deep-link, `rail` opens the thumbnail rail, `print` triggers
     *  the PDF-export auto-print. Examples: #3, #rail, #3,rail, #print. */
    _parseHash() {
      const tokens = (location.hash || "")
        .replace(/^#/, "")
        .split(/[,&]/)
        .filter(Boolean);
      const out = { slide: null, rail: false, print: false };
      for (const t of tokens) {
        if (/^\d+$/.test(t)) out.slide = parseInt(t, 10) - 1;
        else if (t === "rail") out.rail = true;
        else if (t === "print") out.print = true;
      }
      return out;
    }

    /** Mirror slide + rail state into the hash so a copied/reloaded URL
     *  restores the view. replaceState (no history entries, no hashchange
     *  loop) — throws in the opaque-origin preview iframe, where the
     *  host owns the state instead; safe to skip. */
    _writeHash() {
      const tokens = [String(this._index + 1)];
      if (this._railOpen) tokens.push("rail");
      try {
        history.replaceState(null, "", `#${tokens.join(",")}`);
      } catch {
        /* sandboxed iframe */
      }
    }

    _applyHash({ initial = false } = {}) {
      const h = this._parseHash();
      if (h.slide !== null && h.slide >= 0 && h.slide < this._slides.length) {
        this._index = h.slide;
      }
      this._setRailOpen(h.rail, { writeHash: false });
      if (!initial) this._applyIndex({ showOverlay: false });
      if (h.print) this._maybeAutoPrint();
    }

    _setRailOpen(open, { writeHash = true } = {}) {
      if (this._railOpen === open) return;
      this._railOpen = open;
      if (open) this.setAttribute("data-rail-open", "");
      else this.removeAttribute("data-rail-open");
      this._fit();
      if (open) requestAnimationFrame(() => this._scaleThumbs());
      if (writeHash) this._writeHash();
    }

    _applyIndex({ showOverlay = true } = {}) {
      if (!this._slides.length) return;
      const curr = this._index;
      this._slides.forEach((s, i) => {
        if (i === curr) s.setAttribute("data-deck-active", "");
        else s.removeAttribute("data-deck-active");
      });
      if (this._countEl) this._countEl.textContent = String(curr + 1);
      this._thumbs.forEach((t, i) => {
        if (i === curr) {
          t.thumb.setAttribute("data-current", "");
          t.thumb.scrollIntoView({ block: "nearest" });
        } else {
          t.thumb.removeAttribute("data-current");
        }
      });
      this._post({
        type: "state",
        index: curr,
        total: this._slides.length,
        skipped: this._skippedIndices(),
      });
      if (showOverlay) this._flashOverlay();
    }

    _skippedIndices() {
      const out = [];
      this._slides.forEach((s, i) => {
        if (s.hasAttribute("data-deck-skip")) out.push(i);
      });
      return out;
    }

    _go(i, { showOverlay = true } = {}) {
      if (!this._slides.length) return;
      const clamped = Math.max(0, Math.min(this._slides.length - 1, i));
      if (clamped === this._index) {
        if (showOverlay) this._flashOverlay();
        return;
      }
      this._index = clamped;
      this._applyIndex({ showOverlay });
      this._writeHash();
    }

    /** Step forward/back skipping data-deck-skip slides. */
    _advance(dir) {
      if (!this._slides.length) return;
      let i = this._index + dir;
      while (
        i >= 0 &&
        i < this._slides.length &&
        this._slides[i].hasAttribute("data-deck-skip")
      ) {
        i += dir;
      }
      if (i < 0 || i >= this._slides.length) {
        this._flashOverlay();
        return;
      }
      this._go(i);
    }

    _flashOverlay() {
      if (!this._overlay) return;
      this._overlay.setAttribute("data-visible", "");
      if (this._hideTimer) clearTimeout(this._hideTimer);
      this._hideTimer = setTimeout(() => {
        this._overlay.removeAttribute("data-visible");
      }, OVERLAY_HIDE_MS);
    }

    _onMouseMove() {
      this._flashOverlay();
    }

    _onResize() {
      this._fit();
      if (!this._scaleRaf) {
        this._scaleRaf = requestAnimationFrame(() => {
          this._scaleRaf = null;
          this._scaleThumbs();
        });
      }
    }

    _railWidth() {
      if (
        !this._railOpen ||
        this.hasAttribute("no-rail") ||
        NARROW_MQ.matches
      ) {
        return 0;
      }
      return this._railPx || 0;
    }

    _fit() {
      if (!this._canvas) return;
      const rw = this._railWidth();
      if (this._stage) this._stage.style.left = `${rw}px`;
      if (this._overlay) this._overlay.style.marginLeft = `${rw / 2}px`;
      const vw = window.innerWidth - rw;
      const vh = window.innerHeight;
      const s = Math.min(vw / this.designWidth, vh / this.designHeight);
      this._canvas.style.transform = `scale(${s})`;
    }

    _onKey(e) {
      const t = e.target;
      // Don't steal keys while the user is typing (edit mode / inputs).
      if (
        t &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      if (this._editingSlide) return;
      if (this._confirm.hasAttribute("data-open")) {
        if (e.key === "Escape") {
          this._closeConfirm();
          e.preventDefault();
        }
        return;
      }
      if (e.key === "Escape" && this._menu.hasAttribute("data-open")) {
        this._closeMenu();
        e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key;
      let handled = true;
      if (key === "ArrowRight" || key === "PageDown" || key === " ")
        this._advance(1);
      else if (key === "ArrowLeft" || key === "PageUp") this._advance(-1);
      else if (key === "Home") this._go(0);
      else if (key === "End") this._go(this._slides.length - 1);
      else if (key === "r" || key === "R") this._go(0);
      else if (/^[0-9]$/.test(key)) {
        const n = key === "0" ? 9 : parseInt(key, 10) - 1;
        if (n < this._slides.length) this._go(n);
        else handled = false;
      } else handled = false;

      if (handled) {
        e.preventDefault();
        this._flashOverlay();
      }
    }

    _onTap(e) {
      // Touch-only — keyboard + overlay cover desktop nav. Never navigate
      // in edit mode (taps select text instead).
      if (FINE_POINTER_MQ.matches || this._editMode) return;
      const path = e.composedPath();
      if (!this._stage || !path.includes(this._stage)) return;
      if (e.defaultPrevented) return;
      for (const n of path) {
        if (n === this._stage) break;
        if (n instanceof Element && n.matches(INTERACTIVE_SEL)) return;
      }
      e.preventDefault();
      const rw = this._railWidth();
      const mid = rw + (window.innerWidth - rw) / 2;
      this._advance(e.clientX < mid ? -1 : 1);
    }

    // ── Print / PDF export ────────────────────────────────────────────

    _maybeAutoPrint() {
      if (!this._parseHash().print || this._printed) return;
      this._printed = true;
      // Wait for webfonts so the PDF gets the deck's real typography;
      // capped so a broken font URL can't block export forever.
      const go = () => setTimeout(() => window.print(), 50);
      Promise.race([
        document.fonts ? document.fonts.ready : Promise.resolve(),
        new Promise((r) => setTimeout(r, 2000)),
      ]).then(go, go);
    }

    _onHashChange() {
      if (this._parseHash().print) this._printed = false;
      this._applyHash();
    }

    _onBeforePrint() {
      // Print lays every slide out as its own page, so [data-deck-active]-
      // gated entrance styles need the attribute on every slide.
      this._slides.forEach((s) => s.setAttribute("data-deck-active", ""));
    }

    _onAfterPrint() {
      this._applyIndex({ showOverlay: false });
    }

    // ── postMessage protocol ──────────────────────────────────────────

    _post(msg) {
      if (window.parent === window) return;
      try {
        window.parent.postMessage(
          { v: PROTOCOL_V, source: "deck-viewer", ...msg },
          "*",
        );
      } catch {
        /* parent gone */
      }
    }

    _onMessage(e) {
      const d = e.data;
      if (!d || d.v !== PROTOCOL_V || typeof d.type !== "string") return;
      if (d.type === "ack" && typeof d.opId === "string") {
        const pending = this._pendingAcks.get(d.opId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this._pendingAcks.delete(d.opId);
        if (pending.structural) this._railLocked = this._hasPendingStructural();
        if (d.ok === false) {
          this._showToast("Couldn't save the change — reload the preview.");
        }
      } else if (d.type === "set-edit-mode") {
        this._setEditMode(Boolean(d.enabled));
      } else if (d.type === "set-rail") {
        this._setRailOpen(Boolean(d.open));
      } else if (d.type === "goto" && typeof d.index === "number") {
        this._go(d.index, { showOverlay: false });
      } else if (d.type === "print") {
        window.print();
      }
    }

    _hasPendingStructural() {
      for (const p of this._pendingAcks.values()) {
        if (p.structural) return true;
      }
      return false;
    }

    /** Emit an op to the parent. Structural ops lock the rail until the
     *  ack lands so a rapid second click can't address stale indices. */
    _emitOp(op, { structural = false } = {}) {
      const opId = `op-${++this._opSeq}`;
      if (window.parent !== window) {
        const timer = setTimeout(() => {
          this._pendingAcks.delete(opId);
          this._railLocked = this._hasPendingStructural();
          this._showToast("Save timed out — reload the preview.");
        }, ACK_TIMEOUT_MS);
        this._pendingAcks.set(opId, { timer, structural });
        if (structural) this._railLocked = true;
      }
      this._post({
        type: "op",
        opId,
        witness: { childCount: this._slides.length },
        op,
      });
    }

    _showToast(text) {
      if (!this._toast) return;
      this._toast.textContent = text;
      this._toast.setAttribute("data-visible", "");
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        this._toast.removeAttribute("data-visible");
      }, 4000);
    }

    // ── Edit mode ─────────────────────────────────────────────────────

    _setEditMode(enabled) {
      if (this._editMode === enabled) return;
      this._editMode = enabled;
      if (enabled) this.setAttribute("data-edit-mode", "");
      else this.removeAttribute("data-edit-mode");
      // Structural ops (reorder/duplicate/delete/skip) live in the rail —
      // editing without it would be a dead end.
      if (enabled) this._setRailOpen(true);
      this._syncEditable();
      if (!enabled) {
        this._flushTextEdit();
        this._closeMenu();
        this._closeConfirm();
      }
    }

    _syncEditable() {
      for (const s of this._slides) {
        if (this._editMode) {
          s.setAttribute("contenteditable", "true");
          s.setAttribute("spellcheck", "false");
        } else {
          s.removeAttribute("contenteditable");
          s.removeAttribute("spellcheck");
        }
      }
    }

    _onFocusIn(e) {
      if (!this._editMode) return;
      const slide = this._slideFromNode(e.target);
      if (!slide) return;
      if (this._editingSlide && this._editingSlide !== slide)
        this._flushTextEdit();
      this._editingSlide = slide;
      this._editingSnapshot = slide.innerHTML;
    }

    _onFocusOut() {
      if (!this._editingSlide) return;
      // focusout fires before the new focus target settles; defer so a
      // focus move WITHIN the same slide doesn't flush.
      setTimeout(() => {
        const active = document.activeElement;
        if (active && this._slideFromNode(active) === this._editingSlide)
          return;
        this._flushTextEdit();
      }, 0);
    }

    _onInput(e) {
      if (!this._editMode) return;
      const slide = this._slideFromNode(e.target);
      if (!slide || slide !== this._editingSlide) return;
      clearTimeout(this._textDebounce);
      this._textDebounce = setTimeout(
        () => this._flushTextEdit({ keepFocus: true }),
        TEXT_EDIT_DEBOUNCE_MS,
      );
      // Live thumbnail update is cheap enough on the debounce flush only.
    }

    _slideFromNode(node) {
      let n = node;
      while (n && n.parentElement !== this) n = n.parentElement;
      return n && this._slides.includes(n) ? n : null;
    }

    /** Post the edited slide's cleaned HTML if it changed. */
    _flushTextEdit({ keepFocus = false } = {}) {
      clearTimeout(this._textDebounce);
      const slide = this._editingSlide;
      if (!slide) return;
      if (!keepFocus) {
        this._editingSlide = null;
      }
      const snapshot = this._editingSnapshot;
      if (slide.innerHTML === snapshot) return;
      this._editingSnapshot = slide.innerHTML;
      const at = this._slides.indexOf(slide);
      if (at < 0) return;
      this._emitOp({ kind: "replace", at, html: this._cleanSlideHtml(slide) });
      this._refreshThumb(at);
    }

    /** Clone + strip runtime-managed attributes so persisted HTML is clean. */
    _cleanSlideHtml(slide) {
      const clone = slide.cloneNode(true);
      for (const attr of RUNTIME_ATTRS) clone.removeAttribute(attr);
      return clone.outerHTML;
    }

    // ── Structural ops (self-apply + emit) ────────────────────────────

    _deleteSlide(i) {
      if (this._railLocked) return;
      const slide = this._slides[i];
      if (!slide || this._slides.length <= 1) return;
      const cur = this._index;
      this._index =
        i < cur || (i === cur && i === this._slides.length - 1) ? cur - 1 : cur;
      this._emitOp({ kind: "remove", at: i }, { structural: true });
      slide.remove(); // slotchange re-collects + re-renders the rail
    }

    _duplicateSlide(i) {
      if (this._railLocked) return;
      const slide = this._slides[i];
      if (!slide) return;
      this._emitOp({ kind: "duplicate", at: i }, { structural: true });
      const copy = slide.cloneNode(true);
      for (const attr of RUNTIME_ATTRS) copy.removeAttribute(attr);
      copy.removeAttribute("id");
      copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
      this._index = i + 1;
      this.insertBefore(copy, slide.nextSibling);
    }

    _moveSlide(i, j) {
      if (this._railLocked || j < 0 || j >= this._slides.length || j === i)
        return;
      const cur = this._index;
      this._index =
        cur === i
          ? j
          : i < cur && j >= cur
            ? cur - 1
            : i > cur && j <= cur
              ? cur + 1
              : cur;
      const slide = this._slides[i];
      this._emitOp({ kind: "move", from: i, to: j }, { structural: true });
      const ref = j < i ? this._slides[j] : this._slides[j].nextSibling;
      this.insertBefore(slide, ref);
    }

    _toggleSkip(i) {
      if (this._railLocked) return;
      const slide = this._slides[i];
      if (!slide) return;
      const on = !slide.hasAttribute("data-deck-skip");
      this._emitOp(
        on
          ? { kind: "set-attr", at: i, name: "data-deck-skip", value: "" }
          : { kind: "remove-attr", at: i, name: "data-deck-skip" },
        { structural: true },
      );
      if (on) slide.setAttribute("data-deck-skip", "");
      else slide.removeAttribute("data-deck-skip");
      this._markLastVisible();
      const t = this._thumbs[i];
      if (t) {
        if (on) t.thumb.setAttribute("data-skip", "");
        else t.thumb.removeAttribute("data-skip");
      }
      this._post({
        type: "state",
        index: this._index,
        total: this._slides.length,
        skipped: this._skippedIndices(),
      });
    }

    // ── Thumbnail rail ────────────────────────────────────────────────
    //
    // Thumbs are static deep clones rendered inside a nested shadow root
    // per frame. Custom properties inherit across shadow boundaries, and
    // deck templates are inline-style-first, so cloning + a snapshot of
    // the document's stylesheets covers authored styling without the
    // :root-rewriting machinery a fully general solution would need.

    _authorSheet() {
      if (this._sheet !== undefined) return this._sheet;
      const css = Array.from(document.styleSheets)
        .map((sh) => {
          try {
            return Array.from(sh.cssRules)
              .map((r) => r.cssText)
              .join("\n");
          } catch {
            return ""; // cross-origin sheet
          }
        })
        .join("\n");
      try {
        this._sheet = new CSSStyleSheet();
        this._sheet.replaceSync(css);
      } catch {
        this._sheet = null;
        this._sheetCss = css;
      }
      return this._sheet;
    }

    _renderRail() {
      if (!this._rail) return;
      const st = this._rail.scrollTop;
      // Reconcile: reuse thumbs keyed by slide element.
      const bySlide = new Map();
      for (const t of this._thumbs) bySlide.set(t.slide, t);
      const next = [];
      for (const slide of this._slides) {
        let t = bySlide.get(slide);
        if (t) bySlide.delete(slide);
        else t = this._makeThumb(slide);
        next.push(t);
      }
      bySlide.forEach((t) => t.thumb.remove());
      next.forEach((t, i) => {
        const at = this._rail.children[i];
        if (at !== t.thumb) this._rail.insertBefore(t.thumb, at || null);
        t.i = i;
        t.num.textContent = String(i + 1);
        if (t.slide.hasAttribute("data-deck-skip"))
          t.thumb.setAttribute("data-skip", "");
        else t.thumb.removeAttribute("data-skip");
      });
      this._thumbs = next;
      this._rail.scrollTop = st;
      requestAnimationFrame(() => this._scaleThumbs());
    }

    _makeThumb(slide) {
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      thumb.tabIndex = 0;
      const num = document.createElement("div");
      num.className = "num";
      const frame = document.createElement("div");
      frame.className = "frame";
      thumb.append(num, frame);

      const entry = { thumb, num, frame, slide, clone: null, i: -1 };
      const idx = () => entry.i;

      thumb.addEventListener("click", () => this._go(idx()));
      thumb.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        this._go(idx() + (e.key === "ArrowDown" ? 1 : -1));
        const cur = this._thumbs[this._index];
        if (cur) cur.thumb.focus({ preventScroll: true });
      });
      thumb.addEventListener("contextmenu", (e) => {
        if (!this._editMode) return;
        e.preventDefault();
        this._openMenu(idx(), e.clientX, e.clientY);
      });
      thumb.draggable = true;
      thumb.addEventListener("dragstart", (e) => {
        if (!this._editMode || this._railLocked) {
          e.preventDefault();
          return;
        }
        this._dragFrom = idx();
        thumb.setAttribute("data-dragging", "");
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", String(this._dragFrom));
        } catch {
          /* ignore */
        }
      });
      thumb.addEventListener("dragend", () => {
        thumb.removeAttribute("data-dragging");
        this._clearDrop();
        this._dragFrom = null;
      });
      thumb.addEventListener("dragover", (e) => {
        if (this._dragFrom == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = thumb.getBoundingClientRect();
        this._setDrop(
          idx(),
          e.clientY < r.top + r.height / 2 ? "before" : "after",
        );
      });
      thumb.addEventListener("drop", (e) => {
        if (this._dragFrom == null) return;
        e.preventDefault();
        const i = idx();
        const r = thumb.getBoundingClientRect();
        let to = e.clientY >= r.top + r.height / 2 ? i + 1 : i;
        if (this._dragFrom < to) to--;
        const from = this._dragFrom;
        this._clearDrop();
        this._dragFrom = null;
        if (to !== from) this._moveSlide(from, to);
      });

      this._materializeThumb(entry);
      return entry;
    }

    _materializeThumb(entry) {
      const dw = this.designWidth;
      const dh = this.designHeight;
      const clone = entry.slide.cloneNode(true);
      for (const attr of RUNTIME_ATTRS) clone.removeAttribute(attr);
      clone.removeAttribute("id");
      clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
      // Neuter heavy/stateful media in thumbnails.
      clone
        .querySelectorAll("iframe, audio, video, object, embed")
        .forEach((el) => {
          el.removeAttribute("src");
          el.removeAttribute("srcdoc");
          el.innerHTML = "";
        });
      clone.querySelectorAll("img").forEach((el) => {
        el.loading = "lazy";
        el.decoding = "async";
      });
      clone.style.cssText +=
        ";position:absolute;top:0;left:0;transform-origin:0 0;pointer-events:none;" +
        `width:${dw}px;height:${dh}px;box-sizing:border-box;overflow:hidden;` +
        "visibility:visible;opacity:1;";
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;inset:0;";
      const sr = host.attachShadow({ mode: "open" });
      const sheet = this._authorSheet();
      if (sheet) {
        sr.adoptedStyleSheets = [sheet];
      } else if (this._sheetCss) {
        const st = document.createElement("style");
        st.textContent = this._sheetCss;
        sr.appendChild(st);
      }
      sr.appendChild(clone);
      entry.frame.textContent = "";
      entry.frame.appendChild(host);
      entry.clone = clone;
      if (this._thumbScale)
        clone.style.transform = `scale(${this._thumbScale})`;
    }

    _refreshThumb(i) {
      const entry = this._thumbs[i];
      if (entry) this._materializeThumb(entry);
    }

    _scaleThumbs() {
      if (!this._thumbs.length) return;
      const fw = this._thumbs[0].frame.offsetWidth;
      if (!fw) return;
      this._thumbScale = fw / this.designWidth;
      for (const { clone } of this._thumbs) {
        if (clone) clone.style.transform = `scale(${this._thumbScale})`;
      }
    }

    _setDrop(i, where) {
      const t = this._thumbs[i];
      if (this._dropOn && this._dropOn !== t)
        this._dropOn.thumb.removeAttribute("data-drop");
      if (t) t.thumb.setAttribute("data-drop", where);
      this._dropOn = t || null;
    }

    _clearDrop() {
      if (this._dropOn) this._dropOn.thumb.removeAttribute("data-drop");
      this._dropOn = null;
    }

    _openMenu(i, x, y) {
      this._menuIndex = i;
      const slide = this._slides[i];
      const skip = slide && slide.hasAttribute("data-deck-skip");
      this._menu.querySelector('[data-act="skip"]').textContent = skip
        ? "Unskip slide"
        : "Skip slide";
      this._menu.querySelector('[data-act="up"]').disabled = i <= 0;
      this._menu.querySelector('[data-act="down"]').disabled =
        i >= this._slides.length - 1;
      this._menu.querySelector('[data-act="delete"]').disabled =
        this._slides.length <= 1;
      this._menu.style.left = `${x}px`;
      this._menu.style.top = `${y}px`;
      this._menu.setAttribute("data-open", "");
      const r = this._menu.getBoundingClientRect();
      this._menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
      this._menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
    }

    _closeMenu() {
      this._menu.removeAttribute("data-open");
      this._menuIndex = -1;
    }

    _openConfirm(i) {
      this._confirmIndex = i;
      this._confirm.querySelector(".title").textContent =
        `Delete slide ${i + 1}?`;
      this._confirm.setAttribute("data-open", "");
      this._confirm.querySelector(".danger").focus();
    }

    _closeConfirm() {
      this._confirm.removeAttribute("data-open");
      this._confirmIndex = -1;
    }

    // ── Public API ────────────────────────────────────────────────────

    get index() {
      return this._index;
    }
    get length() {
      return this._slides.length;
    }
    goTo(i) {
      this._go(i);
    }
    next() {
      this._advance(1);
    }
    prev() {
      this._advance(-1);
    }
  }

  if (!customElements.get("deck-viewer")) {
    customElements.define("deck-viewer", DeckViewer);
  }
})();
