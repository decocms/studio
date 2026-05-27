/**
 * The Studio-controlled "host" iframe.
 *
 * Instead of loading each page's `index.html` directly, the preview pane
 * loads this host once. The host runs a preact render loop, dynamically
 * imports the page's tokens.js / sections.js / page.js from the
 * `/api/<org>/page-preview/files/...` file server, and exposes a
 * postMessage bridge for Studio to drive transitions in-place:
 *
 *   host:welcome                  show the welcome quiz
 *   host:set-page                 load and render a page (slug + ds slug)
 *   host:show-design-system       render the design-system gallery inline
 *   host:show-design-system-grid  render a card grid of all design systems
 *   host:retheme                  apply a different DS's brand to current page
 *   host:refresh                  re-fetch + re-render current view
 *   host:set-page-progress        set or clear the status overlay (synced
 *                                 with the Studio-side overlay)
 *
 * The host emits back:
 *   host:ready                    initial handshake
 *   page-editor:prompt            user clicked a welcome card or generate
 *   page-editor:runtime-error     captured window.error / unhandledrejection
 *   page-editor:host-select-ds    user clicked a DS card in the grid
 */
const PAGE_PREVIEW_HOST_MARKER = "DECO_PAGE_EDITOR_HOST_V1";

export const PAGE_PREVIEW_HOST_HTML = `<!doctype html>
<!-- ${PAGE_PREVIEW_HOST_MARKER} -->
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Page Editor preview</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=Space+Grotesk:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Press+Start+2P&family=Exo+2:wght@400;600;700;900&family=Fraunces:wght@400;500;600;700&display=swap"
  />
  <script type="importmap">
    {
      "imports": {
        "preact": "https://esm.sh/preact@10.25.4",
        "preact/hooks": "https://esm.sh/preact@10.25.4/hooks",
        "htm": "https://esm.sh/htm@3.1.1"
      }
    }
  </script>
  <style>
    :root {
      --brand-primary: #A595FF;
      --brand-secondary: #22D3EE;
      --brand-accent: #F472B6;
      --brand-bg: #0A0A0F;
      --brand-surface: #15151F;
      --brand-fg: #F6F6F8;
      --brand-muted: #A0A0B0;
      --brand-border: #262633;
      --brand-radius: 12px;
      --font-heading: 'Instrument Serif', Georgia, serif;
      --font-body: 'Inter', system-ui, sans-serif;

      --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
      --space-6: 24px; --space-8: 32px; --space-12: 48px; --space-16: 64px;
      --space-24: 96px;
      --text-xs: 12px; --text-sm: 14px; --text-base: 16px; --text-lg: 18px;
      --text-xl: 22px; --text-2xl: 28px; --text-3xl: 36px; --text-4xl: 48px;
      --text-5xl: 64px;
    }
    html, body { margin: 0; padding: 0; }
    body {
      background: var(--brand-bg);
      color: var(--brand-fg);
      font-family: var(--font-body);
      transition: background-color 320ms cubic-bezier(0.22, 1, 0.36, 1),
                  color 320ms cubic-bezier(0.22, 1, 0.36, 1);
      -webkit-font-smoothing: antialiased;
    }

    .container { max-width: 1100px; margin: 0 auto; padding: 0 var(--space-6); }

    /* ===== Base UI primitives shared across modes =====
     *
     * Every primitive that uses --brand-* tokens gets a 320 ms transition
     * on background-color, color, and border-color. Without this, when
     * applyBrand swaps CSS variables (prelude grayscale → real DS), the
     * body fades smoothly but buttons / cards / inputs snap instantly,
     * causing the "boom, it changed" effect at the end of a build. With
     * the transitions in place the whole iframe re-tints as one. */
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      gap: var(--space-2); padding: var(--space-3) var(--space-6);
      border-radius: var(--brand-radius); font-weight: 600;
      font-size: var(--text-base); border: 1px solid transparent;
      cursor: pointer; font-family: var(--font-body);
      transition:
        transform 80ms ease,
        opacity 150ms ease,
        background-color 320ms cubic-bezier(0.22, 1, 0.36, 1),
        color 320ms cubic-bezier(0.22, 1, 0.36, 1),
        border-color 320ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .btn:active { transform: translateY(1px); }
    .btn-primary { background: var(--brand-primary); color: var(--brand-on-primary, white); }
    .btn-primary:hover { opacity: .9; }
    .btn-secondary {
      background: var(--brand-surface); color: var(--brand-fg);
      border-color: var(--brand-border);
    }
    .btn-ghost { background: transparent; color: var(--brand-fg); border-color: var(--brand-border); }

    .card {
      background: var(--brand-surface);
      border: 1px solid var(--brand-border);
      border-radius: var(--brand-radius);
      padding: var(--space-6);
      transition:
        background-color 320ms cubic-bezier(0.22, 1, 0.36, 1),
        border-color 320ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    .input, .select, .textarea {
      width: 100%; background: var(--brand-bg); color: var(--brand-fg);
      border: 1px solid var(--brand-border); border-radius: var(--brand-radius);
      padding: var(--space-3) var(--space-4); font-family: var(--font-body);
      font-size: var(--text-base);
      transition:
        background-color 320ms cubic-bezier(0.22, 1, 0.36, 1),
        color 320ms cubic-bezier(0.22, 1, 0.36, 1),
        border-color 320ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    .heading { font-family: var(--font-heading); font-weight: 500; letter-spacing: -0.01em; }

    /* ===== Mode crossfade ===== */
    #stage {
      min-height: 100vh;
      transition: opacity 240ms cubic-bezier(0.22, 1, 0.36, 1),
                  filter   240ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    #stage[data-fading="true"] {
      opacity: 0;
      filter: blur(4px);
    }

    /* ===== Section reveal — newly-introduced blocks only =====
       More tactile than a plain fade: starts slightly down + scaled in,
       lands with a brief shadow lift so sections feel like cards being
       dealt rather than DOM nodes blinking into existence. */
    @keyframes section-in {
      0%   { opacity: 0; transform: translateY(14px) scale(0.975); box-shadow: 0 0 0 rgba(0,0,0,0); }
      60%  { box-shadow: 0 18px 60px rgba(0,0,0,0.18); }
      100% { opacity: 1; transform: translateY(0) scale(1); box-shadow: 0 0 0 rgba(0,0,0,0); }
    }
    .section-enter {
      animation: section-in 0.62s cubic-bezier(0.22, 1, 0.36, 1) both;
      will-change: transform, opacity;
    }
    @media (prefers-reduced-motion: reduce) {
      .section-enter, body, #stage { transition: none; animation: none !important; }
    }

    /* ===== Review tips (floating critique tooltips) =====
       Rendered as a child of each section's wrapper, absolutely
       positioned in the section's top-right. Glassy backdrop-filter +
       Accept/Dismiss buttons. Accept fills the chat input and submits
       in one click; Dismiss removes the tip locally. */
    .section-wrapper {
      position: relative;
    }
    .review-tip {
      position: absolute;
      top: 16px;
      right: 16px;
      z-index: 50;
      width: min(320px, calc(100% - 32px));
      background: color-mix(in srgb, var(--brand-bg) 55%, transparent);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid color-mix(in srgb, var(--brand-fg) 18%, transparent);
      border-radius: 14px;
      padding: 14px 16px;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.32),
                  inset 0 1px 0 color-mix(in srgb, var(--brand-fg) 8%, transparent);
      animation: review-tip-in 380ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @keyframes review-tip-in {
      from { opacity: 0; transform: translateY(-6px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .review-tip-eyebrow {
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-weight: 600;
      color: color-mix(in srgb, var(--brand-primary) 90%, var(--brand-fg));
      margin-bottom: 6px;
    }
    .review-tip-text {
      font-size: 13px;
      line-height: 1.5;
      color: color-mix(in srgb, var(--brand-fg) 94%, transparent);
      margin-bottom: 12px;
    }
    .review-tip-actions {
      display: flex;
      gap: 6px;
    }
    .review-tip-btn {
      flex: 1;
      padding: 7px 10px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      border: 1px solid color-mix(in srgb, var(--brand-fg) 16%, transparent);
      transition: opacity 120ms ease, transform 80ms ease, background 150ms ease;
    }
    .review-tip-btn:active { transform: translateY(1px); }
    .review-tip-accept {
      background: var(--brand-primary);
      color: var(--brand-on-primary);
      border-color: transparent;
    }
    .review-tip-accept:hover { opacity: 0.92; }
    .review-tip-dismiss {
      background: transparent;
      color: color-mix(in srgb, var(--brand-fg) 70%, transparent);
    }
    .review-tip-dismiss:hover {
      background: color-mix(in srgb, var(--brand-fg) 6%, transparent);
    }
    @media (max-width: 640px) {
      .review-tip {
        position: relative;
        top: auto;
        right: auto;
        width: auto;
        margin: var(--space-3) var(--space-4);
      }
    }

    /* ===== Review actions bar (Accept all / Dismiss all) =====
       FIXED-position chip pinned to top-right of the iframe whenever at
       least one review tip is active. Above the stepper, above the page,
       above scrolled content — always visible until the user accepts or
       dismisses. Combines all remaining tips' prompts into one
       Accept-all submission so the user fires the whole critique back
       to the agent in one click. */
    .review-actions-bar {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 100;
      display: flex;
      gap: 8px;
      pointer-events: none;
    }
    .review-actions-bar > * { pointer-events: auto; }
    .review-actions-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--brand-bg) 60%, transparent);
      backdrop-filter: blur(16px) saturate(180%);
      -webkit-backdrop-filter: blur(16px) saturate(180%);
      border: 1px solid color-mix(in srgb, var(--brand-fg) 18%, transparent);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      font-size: 12px;
      animation: review-tip-in 320ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .review-actions-label {
      font-weight: 600;
      letter-spacing: 0.04em;
      color: color-mix(in srgb, var(--brand-fg) 85%, transparent);
      padding: 0 6px;
    }
    .review-actions-btn {
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      border: 0;
      transition: opacity 120ms ease, background 150ms ease;
    }
    .review-actions-accept {
      background: var(--brand-primary);
      color: var(--brand-on-primary);
    }
    .review-actions-accept:hover { opacity: 0.92; }
    .review-actions-dismiss {
      background: transparent;
      color: color-mix(in srgb, var(--brand-fg) 70%, transparent);
    }
    .review-actions-dismiss:hover {
      background: color-mix(in srgb, var(--brand-fg) 8%, transparent);
    }

    /* ===== Outline stepper (mini-TOC) =====
       Sticky strip showing the agent's planned section list with done /
       current / planned states. Renders only when state.outline is set. */
    .toc-wrap {
      position: sticky; top: 0; z-index: 30;
      padding: 8px var(--space-6);
      background: color-mix(in srgb, var(--brand-bg) 92%, transparent);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--brand-border);
    }
    .toc-row {
      display: flex; align-items: center; gap: 6px;
      overflow-x: auto; scrollbar-width: none;
      padding: 2px 0;
    }
    .toc-row::-webkit-scrollbar { display: none; }
    .toc-item {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px; letter-spacing: 0.06em; font-weight: 600;
      white-space: nowrap;
      transition: background 200ms ease, color 200ms ease, border-color 200ms ease, opacity 200ms ease, transform 160ms ease;
      border: 1px solid transparent;
      /* Reset button defaults — these are now <button> elements (clickable
         for time-travel) but should look pill-shaped. */
      background: transparent;
      font-family: inherit;
      cursor: default;
    }
    .toc-item:disabled { cursor: default; }
    .toc-item-clickable { cursor: pointer; }
    .toc-item-clickable:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--brand-fg) 35%, transparent);
    }
    .toc-item-clickable:active { transform: translateY(0); }
    .toc-item-rewindable::before {
      content: '↻';
      margin-right: 2px;
      opacity: 0.6;
      font-size: 11px;
    }
    .toc-item-done {
      background: color-mix(in srgb, var(--brand-surface) 80%, transparent);
      color: color-mix(in srgb, var(--brand-fg) 75%, transparent);
      border-color: var(--brand-border);
    }
    .toc-item-current {
      background: color-mix(in srgb, var(--brand-primary) 22%, transparent);
      color: var(--brand-fg);
      border-color: color-mix(in srgb, var(--brand-primary) 70%, transparent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand-primary) 14%, transparent);
      animation: toc-current-pulse 2.4s ease-in-out infinite;
    }
    .toc-item-viewing {
      background: var(--brand-fg);
      color: var(--brand-bg);
      border-color: var(--brand-fg);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand-fg) 18%, transparent);
    }
    .toc-item-viewing .toc-dot { background: var(--brand-bg); opacity: 1; }
    .toc-item-planned {
      color: color-mix(in srgb, var(--brand-muted) 80%, transparent);
      border-color: color-mix(in srgb, var(--brand-border) 80%, transparent);
      background: transparent;
      opacity: 0.55;
    }
    .toc-item-live {
      background: color-mix(in srgb, var(--brand-primary) 18%, transparent);
      color: var(--brand-fg);
      border-color: color-mix(in srgb, var(--brand-primary) 50%, transparent);
      animation: toc-live-pulse 1.6s ease-in-out infinite;
    }
    .toc-item-live .toc-dot {
      background: var(--brand-primary);
      box-shadow: 0 0 8px var(--brand-primary);
    }
    .toc-dot {
      width: 6px; height: 6px; border-radius: 999px;
      background: currentColor; opacity: 0.7;
    }
    .toc-item-done .toc-dot { background: var(--brand-primary); opacity: 1; }
    .toc-item-current .toc-dot { background: var(--brand-primary); opacity: 1; box-shadow: 0 0 8px var(--brand-primary); }
    .toc-sep {
      width: 14px; height: 1px;
      background: color-mix(in srgb, var(--brand-border) 100%, transparent);
      flex-shrink: 0;
    }
    @keyframes toc-current-pulse {
      0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand-primary) 14%, transparent); }
      50%      { box-shadow: 0 0 0 6px color-mix(in srgb, var(--brand-primary) 8%, transparent); }
    }
    @keyframes toc-live-pulse {
      0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--brand-primary) 30%, transparent); }
      50%      { box-shadow: 0 0 0 5px color-mix(in srgb, var(--brand-primary) 0%, transparent); }
    }

    /* Crossfade <main> when the user time-travels between stepper steps.
       <main> is keyed on the resolved view step, so a step click remounts
       this element and re-triggers the fade-in. */
    .page-main {
      animation: page-main-fade-in 280ms cubic-bezier(0.22, 1, 0.36, 1);
      /* Bottom spacer (100vh) gives scrollIntoView({ block: 'center' })
         the room it needs to center each section while the build is
         in flight. Once the outline is structurally complete (footer
         landed), .is-done collapses the spacer with a smooth
         transition — the footer is semantically the bottom, so we
         skip the center-scroll for it and let it settle naturally
         before the 3 s hold + scroll-to-top. */
      padding-bottom: 100vh;
      transition: padding-bottom 700ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .page-main.is-done {
      padding-bottom: 0;
    }
    @keyframes page-main-fade-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    /* DS-phase main fills the viewport so the gallery feels generous,
       not boxed. The page-shell wrapper above is already a flex
       container in this mode (we set it inline) so min-height: 100vh
       on the main pushes the page to fill the iframe. */
    .page-main-ds {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
    }

    /* ===== Unified design phase (DS gallery + section library) =====
     *
     * Renders during the unified 'design' phase as one board with a
     * left/right split: DS gallery on the left, section library on
     * the right. HARD-CODED PX VALUES throughout — the brand's space
     * tokens only define a subset (space-1/2/3/4/6/8/12/16) and any
     * reference to undefined ones (space-5/7/10) silently drops the
     * declaration, so we don't depend on them here.
     */
    .up-board {
      display: flex;
      flex-direction: column;
      padding: 24px 32px 32px;
      max-width: 1400px;
      margin: 0 auto;
      width: 100%;
      align-self: center;
      gap: 20px;
      min-height: calc(100vh - 80px);
    }
    .up-header {
      display: flex;
      align-items: baseline;
      gap: 20px;
      flex-wrap: wrap;
      padding: 4px 4px 0;
    }
    .up-title {
      font-family: var(--font-heading);
      font-size: var(--text-3xl);
      line-height: 1;
    }
    .up-tag {
      font-size: 11px;
      letter-spacing: .14em;
      text-transform: uppercase;
      color: var(--brand-muted);
    }
    .up-split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      flex: 1;
      min-height: 0;
    }
    @media (max-width: 980px) {
      .up-split { grid-template-columns: 1fr; }
    }
    .up-ds, .up-library {
      background: color-mix(in srgb, var(--brand-fg) 5%, var(--brand-surface));
      border: 1px solid color-mix(in srgb, var(--brand-fg) 10%, var(--brand-border));
      border-radius: var(--brand-radius);
      padding: 24px 28px;
      min-width: 0;
      overflow: auto;
    }
    .up-ds > .up-band + .up-band { margin-top: 28px; }
    .up-lib-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 560px) {
      .up-lib-grid { grid-template-columns: 1fr; }
    }
    .ds-eyebrow {
      font-size: 11px;
      letter-spacing: .16em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--brand-fg) 65%, transparent);
      font-weight: 600;
      margin: 0 0 20px;
    }
    /* Color palette — 4-column grid (half-width inside the split). */
    .ds-palette {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    @media (max-width: 720px) {
      .ds-palette { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    }
    .swatch { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .swatch-chip {
      height: 56px;
      border-radius: calc(var(--brand-radius) * 0.6);
      border: 1px solid var(--brand-border);
      transition: background-color 480ms cubic-bezier(0.22, 1, 0.36, 1),
                  border-color 480ms cubic-bezier(0.22, 1, 0.36, 1),
                  border-radius 320ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .swatch-name { font-size: 13px; color: var(--brand-fg); font-weight: 500; line-height: 1.1; }
    .swatch-hex {
      font-size: 11px; color: var(--brand-muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* Typography — three labeled samples with REAL gap. */
    .ds-typo-stack > * + * { margin-top: 28px; }
    .ds-typo-stack .typo-meta {
      font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
      color: var(--brand-muted); margin: 0 0 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .ds-typo-stack .typo-meta + * { margin: 0; }
    /* Components column — Cards / Buttons / Form rows separated by
       generous gaps. */
    .ds-components-stack > * + * { margin-top: 28px; }
    .ds-sub-eyebrow {
      font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
      color: var(--brand-muted); margin: 0 0 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .ds-cards-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    @media (max-width: 560px) { .ds-cards-row { grid-template-columns: 1fr; } }
    .ds-card-compact {
      background: var(--brand-bg);
      border: 1px solid var(--brand-border);
      border-radius: var(--brand-radius);
      padding: 14px 16px;
      min-width: 0;
    }
    .ds-buttons { display: flex; flex-wrap: wrap; gap: 12px; }
    .ds-form-row-controls {
      display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
    }
    @media (max-width: 560px) { .ds-form-row-controls { grid-template-columns: 1fr; } }
    .ds-form-row-controls .input, .ds-form-row-controls .select { width: 100%; }
    code { background: var(--brand-bg); border: 1px solid var(--brand-border); padding: 1px 5px; border-radius: 6px; font-size: 11px; color: var(--brand-muted); }

    /* ===== Section library pills =====
     * Rendered inside the right half of UnifiedDesignPhase. Each
     * category tile lists its section names as pills; pills in the
     * agent's outline get filled with the brand primary + a checkmark
     * via the pill-highlight keyframes (staggered per pill). */
    .sl-category {
      background: color-mix(in srgb, var(--brand-fg) 5%, var(--brand-surface));
      border: 1px solid color-mix(in srgb, var(--brand-fg) 10%, var(--brand-border));
      border-radius: var(--brand-radius);
      padding: 16px 18px;
      min-width: 0;
    }
    .sl-eyebrow {
      font-size: 11px;
      letter-spacing: .16em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--brand-fg) 65%, transparent);
      font-weight: 600;
      margin: 0 0 12px;
    }
    .sl-pills {
      display: flex; flex-direction: column; gap: 6px;
    }
    .sl-pill {
      display: flex; justify-content: space-between; align-items: center;
      font-size: 12px; padding: 6px 10px;
      border-radius: 8px;
      background: var(--brand-bg);
      border: 1px solid var(--brand-border);
      color: color-mix(in srgb, var(--brand-fg) 55%, transparent);
      /* All pills start gray. Selected ones run the pill-highlight
         keyframes with a per-pill animation-delay so the highlights
         pop in one-by-one — that's the "agent picked these" moment.
         The transitions stay so re-renders (e.g. stepper time-travel)
         re-tint smoothly. */
      transition:
        background-color 320ms cubic-bezier(0.22, 1, 0.36, 1),
        color 320ms cubic-bezier(0.22, 1, 0.36, 1),
        border-color 320ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .sl-pill-on {
      animation: pill-highlight 520ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @keyframes pill-highlight {
      0%   {
        background: var(--brand-bg);
        color: color-mix(in srgb, var(--brand-fg) 55%, transparent);
        border-color: var(--brand-border);
        transform: scale(1);
      }
      55%  {
        background: var(--brand-primary);
        color: var(--brand-on-primary, white);
        border-color: transparent;
        transform: scale(1.06);
        box-shadow: 0 6px 18px color-mix(in srgb, var(--brand-primary) 35%, transparent);
      }
      100% {
        background: var(--brand-primary);
        color: var(--brand-on-primary, white);
        border-color: transparent;
        font-weight: 600;
        transform: scale(1);
        box-shadow: 0 0 0 rgba(0,0,0,0);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .sl-pill-on { animation: none; background: var(--brand-primary); color: var(--brand-on-primary, white); border-color: transparent; font-weight: 600; }
    }
    .sl-check { font-size: 11px; opacity: 0.85; }

    /* ===== DS-grid (manage design systems) ===== */
    .dsg-wrap { padding: var(--space-16) 0; }
    .dsg-head { display:flex; align-items:center; justify-content:space-between; margin-bottom: var(--space-8); gap: var(--space-4); }
    .dsg-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-4); }
    .dsg-card {
      background: var(--brand-surface);
      border: 1px solid var(--brand-border);
      border-radius: var(--brand-radius);
      padding: var(--space-4);
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease;
    }
    .dsg-card:hover { transform: translateY(-2px); border-color: var(--brand-fg); }
    .dsg-swatches { display:flex; height: 60px; border-radius: 8px; overflow:hidden; margin-bottom: var(--space-3); }
    .dsg-name { font-family: var(--font-heading); font-size: var(--text-xl); margin-bottom: 4px; }
    .dsg-sub { color: var(--brand-muted); font-size: var(--text-xs); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

    /* ===== Prelude phase: agent has just started, no DS yet =====
       Bare canvas under the stepper. The brief is already in the chat;
       the iframe just holds an empty (soft-gradient) stage so the eye
       lands on the stepper above. */
    .prelude-stage {
      min-height: calc(100vh - 64px);
      background:
        radial-gradient(50% 40% at 50% 0%, color-mix(in srgb, var(--brand-primary) 14%, transparent) 0%, transparent 65%),
        var(--brand-bg);
      animation: prelude-in 380ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @keyframes prelude-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    /* ===== Stepper visibility lifecycle =====
       The stepper is the only persistent chrome: visible from prelude
       through done. Once isRunning flips false AND a settle delay
       passes, the stepper fades out gracefully. */
    .toc-wrap {
      transition: opacity 480ms cubic-bezier(0.22, 1, 0.36, 1),
                  transform 480ms cubic-bezier(0.22, 1, 0.36, 1);
      animation: toc-in 360ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @keyframes toc-in {
      from { opacity: 0; transform: translateY(-6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .toc-wrap[data-settling="true"] {
      opacity: 0;
      transform: translateY(-6px);
    }
    /* Shimmer placeholder step shown before the outline arrives.
       A single pill that pulses gently so the user has a "we're on it"
       anchor even in the first second of the build. */
    .toc-item-shimmer {
      background: color-mix(in srgb, var(--brand-surface) 70%, transparent);
      color: color-mix(in srgb, var(--brand-fg) 72%, transparent);
      border-color: var(--brand-border);
      animation: toc-shimmer 1.6s ease-in-out infinite;
    }
    .toc-item-shimmer .toc-dot {
      background: var(--brand-primary);
      opacity: 1;
      box-shadow: 0 0 8px var(--brand-primary);
    }
    @keyframes toc-shimmer {
      0%, 100% { opacity: 0.7; }
      50%      { opacity: 1; }
    }
    /* ===== Empty / loading ===== */
    .empty-pulse {
      display: inline-flex; align-items: center; justify-content: center;
      width: 56px; height: 56px; border-radius: 999px;
      background: var(--brand-surface); border: 1px solid var(--brand-border);
      margin-bottom: var(--space-6);
      animation: empty-pulse 1.4s ease-in-out infinite;
    }
    @keyframes empty-pulse {
      0%, 100% { transform: scale(1);   opacity: 1; }
      50%      { transform: scale(1.08); opacity: 0.7; }
    }

    /* ===== Welcome quiz ===== */
    .welcome-root {
      min-height: 100vh;
      background: #0A0A0F;
      color: #FAFAF9;
      font-family: 'Inter', system-ui, sans-serif;
      background-image:
        radial-gradient(60% 50% at 50% 0%, rgba(165,149,255,0.18) 0%, rgba(10,10,15,0) 70%),
        radial-gradient(40% 30% at 80% 100%, rgba(208,236,26,0.10) 0%, rgba(10,10,15,0) 70%);
    }
    .welcome-pill { color: rgba(165,149,255,0.85); font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; }
    .welcome-h1 { font-family: 'Instrument Serif', Georgia, serif; font-size: clamp(34px, 5vw, 60px); font-weight: 500; line-height: 1.05; text-align: center; max-width: 720px; margin: 0 auto; }
    .welcome-sub { max-width: 520px; margin: 16px auto 0; color: rgba(255,255,255,0.6); text-align: center; }
    .qcard {
      background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.10);
      border-radius: 12px; padding: 16px; cursor: pointer; text-align: left;
      transition: background .12s ease, border-color .12s ease, transform .08s ease;
      min-width: 180px; flex: 1 1 180px;
      color: inherit; font-family: inherit;
    }
    .qcard:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.20); }
    .qcard:active { transform: translateY(1px); }
    .qcard.selected {
      background: rgba(165,149,255,0.16);
      border-color: rgba(165,149,255,0.85);
      box-shadow: 0 0 0 1px rgba(165,149,255,0.7);
    }
    .qcard .qcheck { opacity: 0; transform: scale(.6); transition: opacity .12s, transform .12s; width:16px; height:16px; border-radius:999px; background:#A595FF; color:#0A0A0F; display:inline-flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; }
    .qcard.selected .qcheck { opacity: 1; transform: scale(1); }
    .cta-pill {
      transition: opacity 0.15s ease, transform 0.08s ease, background 0.15s ease;
    }
    .cta-pill:disabled { opacity: 0.35; cursor: not-allowed; }
    .cta-pill:not(:disabled):hover { background: #B6A8FF; }
  </style>

  <!-- Runtime error capture: same beautiful card as the page template uses,
       so any error in a dynamically-imported page chunk shows up nicely. -->
  <script>
    (function () {
      var rendered = false;
      function relPath(p) {
        try {
          if (!p) return '';
          var u = new URL(p);
          var m = u.pathname.match(/\\/page-preview\\/files\\/(.*)$/);
          return m ? decodeURIComponent(m[1]) : u.pathname + (u.search || '');
        } catch (_e) { return String(p); }
      }
      function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
      function show(info) {
        if (rendered) return;
        rendered = true;
        var fg = getComputedStyle(document.documentElement).getPropertyValue('--brand-fg') || '#FAFAF9';
        var border = getComputedStyle(document.documentElement).getPropertyValue('--brand-border') || 'rgba(255,255,255,0.15)';
        var primary = getComputedStyle(document.documentElement).getPropertyValue('--brand-primary') || '#A595FF';
        var node = document.createElement('div');
        node.id = '__host_error_card__';
        node.setAttribute('role', 'alert');
        node.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:32px;background:var(--brand-bg);color:' + fg + ';font-family:Inter,system-ui,sans-serif;animation:hef 240ms ease-out both;';
        node.innerHTML = '<style>@keyframes hef{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}</style>'
          + '<div style="max-width:640px;width:100%;background:rgba(255,255,255,0.03);border:1px solid ' + border + ';border-radius:16px;padding:24px 28px;box-shadow:0 18px 60px rgba(0,0,0,0.35);">'
          + '<span style="display:inline-flex;align-items:center;gap:8px;padding:4px 10px;border-radius:999px;background:rgba(239,68,68,0.14);color:#fca5a5;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">Runtime error</span>'
          + '<h2 style="margin:18px 0 8px;font-family:var(--font-heading,inherit);font-weight:500;font-size:24px;line-height:1.25;">' + esc(info.headline) + '</h2>'
          + (info.location ? '<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;opacity:0.65;margin-bottom:16px;">' + esc(info.location) + '</div>' : '')
          + '<div style="background:rgba(0,0,0,0.25);border:1px solid ' + border + ';border-radius:10px;padding:12px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;white-space:pre-wrap;word-break:break-word;line-height:1.5;max-height:200px;overflow:auto;">' + esc(info.message) + '</div>'
          + '<div style="display:flex;gap:8px;margin-top:18px;align-items:center;">'
          + '<button type="button" data-act="ask" style="appearance:none;cursor:pointer;border:0;background:' + primary + ';color:#0A0A0F;font:600 13px/1 Inter,system-ui,sans-serif;padding:10px 16px;border-radius:999px;">Ask the agent to fix this</button>'
          + '<button type="button" data-act="reload" style="appearance:none;cursor:pointer;background:transparent;color:' + fg + ';border:1px solid ' + border + ';font:600 13px/1 Inter,system-ui,sans-serif;padding:10px 16px;border-radius:999px;">Reload preview</button>'
          + '</div></div>';
        document.body.appendChild(node);
        node.querySelector('[data-act="ask"]').addEventListener('click', function () {
          parent.postMessage({ type: 'page-editor:runtime-error', payload: info }, '*');
          this.textContent = 'Sent to chat ✓';
          this.style.opacity = '0.55';
        });
        node.querySelector('[data-act="reload"]').addEventListener('click', function () {
          rendered = false;
          node.remove();
          parent.postMessage({ type: 'page-editor:host-request-refresh' }, '*');
        });
      }
      window.addEventListener('error', function (e) {
        var rel = relPath(e.filename || '');
        var loc = rel ? rel + (e.lineno ? ':' + e.lineno : '') + (e.colno ? ':' + e.colno : '') : '';
        var raw = (e.error && (e.error.stack || e.error.message)) || e.message || String(e);
        show({ headline: (e.error && e.error.name) ? e.error.name + ' in the preview' : 'A script error stopped the page', location: loc, message: String(raw) });
      });
      window.addEventListener('unhandledrejection', function (e) {
        var reason = e.reason;
        var msg = (reason && (reason.stack || reason.message)) || String(reason);
        show({ headline: 'Unhandled promise rejection', location: '', message: String(msg) });
      });
      window.__pe_host_clear_error = function () {
        rendered = false;
        var n = document.getElementById('__host_error_card__');
        if (n) n.remove();
      };
    })();
  </script>
</head>
<body>
  <div id="stage" data-fading="false"></div>
  <script type="module">
    import { h, render, Fragment, Component } from 'preact';
    import { useEffect, useState } from 'preact/hooks';
    import htm from 'htm';

    const html = htm.bind(h);
    const stage = document.getElementById('stage');

    /* ---------------- State ---------------- */

    /** @type {{
     *   mode: 'welcome' | 'page' | 'ds-grid' | 'empty',
     *   filesBase: string,                 // /api/<org>/page-preview
     *   brand: Record<string, string> | null,
     *   pageSlug: string | null,
     *   pageDsSlug: string | null,
     *   pageDsName: string | null,
     *   blocks: Array<{section: string, props: any}>,
     *   Sections: Record<string, Function>,
     *   designSystems: Array<{slug: string, name: string, brand: Record<string,string>}>,
     *   emptyLabel: string | null,
     *   thinkingPrompt: string | null,
     *   progressLabel: string | null,
     *   isRunning: boolean,
     *   outline: string[] | null,
     *   buildDesignSystem: {slug:string,name:string,brand:Record<string,string>} | null,
     *   buildPageCreated: boolean,
     *   buildPageActivated: boolean,
     *   buildEndedAt: number | null,
     * }} */
    // Derive filesBase from the host's own URL so we don't have to wait
    // for the Studio-side handshake before dispatching imports. The host
    // is mounted at /api/<org>/page-preview/host. Page-preview assets
    // live under Studio's canonical /api/<org>/files/page-preview/...
    // redirect, so we strip the page-preview/host tail and re-attach the
    // files prefix.
    function deriveFilesBaseFromLocation() {
      try {
        var p = location.pathname.replace(/\\/page-preview\\/host\\/?$/, '');
        return p + '/files/page-preview';
      } catch (_e) {
        return '';
      }
    }

    const state = {
      mode: 'welcome',
      filesBase: deriveFilesBaseFromLocation(),
      brand: null,
      pageSlug: null,
      pageDsSlug: null,
      pageDsName: null,
      blocks: [],
      Sections: {},
      designSystems: [],
      emptyLabel: null,
      thinkingPrompt: null,
      progressLabel: null,
      isRunning: false,
      outline: null,
      // Time-travel cursor for the OutlineStepper. null = follow live build.
      // A number pins the right-pane to that historical stepper position
      // (0 = "Design system" only, N = first N outline sections). Cleared
      // on mode transitions and on PAGE_PREVIEW_PAGE_CREATE for new builds.
      viewStepIdx: null,
      buildDesignSystem: null,
      buildPageCreated: false,
      buildPageActivated: false,
      // Choreographed-loading timing. Each "phase" has a minimum visible
      // duration so no step flashes by. The agent's tool calls advance
      // state immediately; the render layer below uses these timestamps
      // to decide which view to show. setTimeout(rerender) is scheduled
      // at each upcoming phase boundary so the UI transitions on time.
      dsArrivedAt: null, // ms epoch when state.brand first appeared
      pageCreatedAt: null, // ms epoch when buildPageCreated first became true
      firstBlockArrivedAt: null, // ms epoch when state.blocks first reached length > 0
      // ms epoch when isRunning flipped true → false (build ended). Drives the
      // post-completion stepper fade-out — we hold the stepper for STEPPER_SETTLE_MS
      // after the build ends so the user gets a final "everything is done" beat,
      // then it fades out.
      buildEndedAt: null,
      // Pending RENDER_BLOCK messages deferred during the design
      // phase floor window. Replayed when the floor elapses so the
      // build resumes naturally.
      deferredRenderBlocks: [],
      // Review tips published by the agent's review pass. Studio walks
      // the chat stream for PAGE_REVIEW_SUGGEST tool calls and pushes
      // them in via host:set-review-tips. Each is { id, section, prompt }.
      reviewTips: [],
      // Tip ids the user dismissed locally (✕ button or Dismiss all).
      // We keep them in a set rather than mutating reviewTips so a
      // re-derived list from Studio (e.g. if the user re-runs a build
      // that emits the same tips with new ids) doesn't resurrect ghosts.
      dismissedTipIds: new Set(),
    };

    /** Phase minimums (ms). The unified 'design' phase shows the DS
     *  gallery side-by-side with the section library. designFloor is
     *  the minimum visible time (blocks arriving sooner get deferred);
     *  designCeil is the cap when no block has arrived yet — past it,
     *  the phase exits to 'layout' so the user isn't staring at a
     *  static board. */
    const PHASE_MIN_MS = {
      designFloor: 8000,
      designCeil: 10000,
    };
    /** How long to hold the stepper after the build ends before fading. */
    const STEPPER_SETTLE_MS = 1500;

    /** Default brand used in the prelude phase. Intentionally NEUTRAL
     *  grayscale so when the real DS lands the brand-color shift reads
     *  as a clear visual event — colored primary/accent on grayscale
     *  prelude pops, whereas the previous violet+cyan+pink default
     *  meant the prelude already looked like a finished brand and
     *  whatever real DS landed felt like a side-step, not an arrival. */
    const DEFAULT_PRELUDE_BRAND = {
      name: 'Default style',
      primary: '#6B7280',
      secondary: '#9CA3AF',
      accent: '#D1D5DB',
      bg: '#0A0A0F',
      surface: '#15151F',
      fg: '#F6F6F8',
      muted: '#A0A0B0',
      border: '#262633',
    };
    /** Track scheduled rerender so we don't pile up timers. */
    let nextPhaseRerenderAt = 0;
    function scheduleRerenderAt(targetMs) {
      const delay = Math.max(60, targetMs - Date.now());
      if (nextPhaseRerenderAt && nextPhaseRerenderAt <= targetMs) return;
      nextPhaseRerenderAt = targetMs;
      setTimeout(() => {
        nextPhaseRerenderAt = 0;
        rerender();
      }, delay);
    }

    /**
     * Sections we've already rendered. Source-of-truth gate for the
     * entry animation: only NEW keys get the .section-enter class.
     * The real re-flicker bug was the <main> remount caused by a
     * volatile key; that's fixed by keying <main> on the time-travel
     * pin state (state.viewStepIdx), so we no longer need the
     * onAnimationEnd belt-and-suspenders strip.
     */
    let seenSectionKeys = new Set();

    /** Called from every mode/page transition that should invalidate
     *  the "already-animated" set so the next render's new content
     *  gets the entry animation. Centralized to keep the lifecycle
     *  legible. */
    function resetReveal() {
      seenSectionKeys = new Set();
    }

    /**
     * Flush any blocks deferred during the design phase floor window.
     * Replays them through queueReveal so the pacing is the same as
     * for live blocks arriving past the floor — every reveal gets
     * MIN_REVEAL_INTERVAL_MS of breathing room.
     */
    function drainDeferredBlocks() {
      if (!state.deferredRenderBlocks || state.deferredRenderBlocks.length === 0) return;
      const queued = state.deferredRenderBlocks;
      state.deferredRenderBlocks = [];
      for (const block of queued) queueReveal(block);
    }

    /**
     * Minimum gap between consecutive live reveals. The section-center
     * scroll is ~500–700 ms of "the page is moving"; this gap gives the
     * user ~800 ms of stillness on the just-landed section before the
     * next one starts moving them. Feels readable, not glacial.
     */
    const MIN_REVEAL_INTERVAL_MS = 1500;
    let lastRevealAt = 0;

    /**
     * Enqueue a block for reveal. Live reveals (state.isRunning === true)
     * are paced so consecutive reveals are at least MIN_REVEAL_INTERVAL_MS
     * apart — gives the user time to read each section before the
     * scroll moves on. Replay reveals (refresh of a done page) bypass
     * pacing and commit immediately (revealBlock takes the silent-commit
     * branch when isRunning is false).
     */
    function queueReveal(block) {
      if (!state.isRunning) {
        revealBlock(block);
        return;
      }
      const now = Date.now();
      const earliest = Math.max(now, lastRevealAt + MIN_REVEAL_INTERVAL_MS);
      lastRevealAt = earliest;
      if (earliest === now) {
        revealBlock(block);
      } else {
        setTimeout(() => revealBlock(block), earliest - now);
      }
    }

    /**
     * Reveal one block: upsert into state.blocks by section name, re-
     * render, scroll the new block to vertical center. When the outline
     * completes, hold 3 s on the last section then scroll back to top
     * so the user lands on Hero of the finished page.
     *
     * Called synchronously from host:render-block — no throttle, no
     * queue, no buffering. The agent's sequential RENDER_BLOCK pace IS
     * the reveal pace.
     */
    function revealBlock(block) {
      if (!Array.isArray(state.blocks)) state.blocks = [];
      const wasEmpty = state.blocks.length === 0;
      if (wasEmpty && !state.firstBlockArrivedAt) {
        state.firstBlockArrivedAt = Date.now();
      }

      // Distinguish a LIVE reveal (the agent is shipping right now —
      // task in progress, scroll choreography wanted) from a REPLAY
      // (refreshing a finished page → Studio replays every historical
      // render-block from the chat stream → without this guard, every
      // section fires its own scrollSectionToCenter and the user sees
      // a cacophony of scrolls "settling" through the whole build).
      //
      // The signal: state.isRunning is set by host:set-page-progress.
      // On a live build it's true by the time the first block lands;
      // on a refresh of a done page it's false and stays false.
      const isLiveReveal = state.isRunning === true;

      // Upsert by section name. Landing pages don't repeat sections;
      // a duplicate name almost always means a re-dispatch. In-place
      // replacement keeps the reveal-key stable so the section doesn't
      // re-animate.
      const existingIdx = state.blocks.findIndex(
        (b) => b && b.section === block.section,
      );
      if (existingIdx >= 0) state.blocks[existingIdx] = block;
      else state.blocks.push(block);

      // Replay path: just commit + rerender. No scroll, no isRunning
      // bump, no "outline complete → scroll to top" choreography (the
      // page is already done; the user just opened it).
      if (!isLiveReveal) {
        if (state.mode !== 'page') {
          setMode('page');
        } else {
          rerender();
        }
        return;
      }

      // Live path: rerender, scroll the new section to viewport center
      // — UNLESS this reveal completes the outline (i.e. it's the
      // footer). Footer is semantically the bottom of the page; the
      // .is-done class collapses the bottom spacer the same render
      // tick, so the page settles naturally with the footer at the
      // bottom (no awkward center-the-footer-then-collapse jump).
      // Then hold 3 s and scroll to top so the user lands on Hero of
      // the finished page.
      const outline = Array.isArray(state.outline) ? state.outline : [];
      const isOutlineComplete =
        outline.length > 0 && state.blocks.length >= outline.length;
      const afterRender = () => {
        if (isOutlineComplete) {
          setTimeout(() => scrollIframeToTop(), 3000);
        } else {
          scrollSectionToCenter(block.section);
        }
      };
      if (state.mode !== 'page') {
        setMode('page').then(afterRender);
      } else {
        rerender();
        afterRender();
      }
    }

    /* ---------------- Brand vars ---------------- */

    // URL-scheme sanitizer for agent-supplied block props. Mirrors the
    // server-side sanitizeBlockProps in service.ts so the live preview is
    // safe even when the chat-stream watcher dispatches a host:render-block
    // straight from the agent's tool call (which doesn't go through the
    // server-side write path).
    function _safeUrl(v) {
      if (typeof v !== 'string') return v;
      var t = v.trim();
      if (!t) return v;
      if (t[0] === '#' || t[0] === '/') return v;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) return v;
      var l = t.toLowerCase();
      if (l.startsWith('http://') || l.startsWith('https://') ||
          l.startsWith('mailto:') || l.startsWith('tel:')) return v;
      return '#';
    }
    var URL_PROP_RE = /^(?:href|src|.*Href|.*Src)$/i;
    function sanitizeBlockProps(input) {
      function visit(v) {
        if (Array.isArray(v)) return v.map(visit);
        if (v && typeof v === 'object') {
          var out = {};
          for (var k in v) {
            if (Object.prototype.hasOwnProperty.call(v, k)) {
              out[k] = URL_PROP_RE.test(k) ? _safeUrl(v[k]) : visit(v[k]);
            }
          }
          return out;
        }
        return v;
      }
      return visit(input);
    }

    function camelToKebab(s) {
      return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    }
    function normalizeFont(value) {
      if (!value) return value;
      var t = String(value).trim();
      if (!t) return t;
      if (t.includes(',')) return t;
      if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t;
      if (/\\s/.test(t)) return "'" + t.replace(/'/g, '') + "'";
      return t;
    }
    function applyBrand(brand) {
      if (!brand) return;
      // Idempotence guard: if the incoming brand's signature matches what's
      // already applied, skip. Prevents a flash when multiple dispatch
      // paths (host:set-page-progress, host:set-page, host:render-block
      // lazy-load) all converge on the same brand within a few hundred ms
      // — without this, the redundant applyBrand calls were observed
      // causing a perceptible "old DS appears briefly" artifact when the
      // CSS transition retargeted mid-animation from a partially-applied
      // intermediate color.
      const sig = (brand.primary || '') + '|' + (brand.bg || '') + '|' + (brand.name || '');
      if (state.brand && state._brandSig === sig) return;
      const isFirstBrand = !state.brand;
      state.brand = brand;
      state._brandSig = sig;
      if (isFirstBrand) state.dsArrivedAt = Date.now();
      const r = document.documentElement;
      // Map every brand token to a CSS variable. Includes the on-* contrast
      // tokens (onPrimary/onSecondary/onAccent) — without these, .btn-primary
      // and .shell-nav-cta read \`var(--brand-on-primary)\` against a hot
      // primary background and end up with the CSS fallback (white), which
      // fails contrast on light-primary themes like cyber-lime.
      const tokenKeys = [
        'primary', 'secondary', 'accent', 'bg', 'surface', 'fg', 'muted',
        'border', 'radius', 'onPrimary', 'onSecondary', 'onAccent',
      ];
      for (const k of tokenKeys) {
        if (brand[k]) r.style.setProperty('--brand-' + camelToKebab(k), brand[k]);
      }
      if (brand.headingFont) {
        r.style.setProperty('--font-heading', normalizeFont(brand.headingFont) + ", 'Instrument Serif', Georgia, serif");
      }
      if (brand.bodyFont) {
        r.style.setProperty('--font-body', normalizeFont(brand.bodyFont) + ", Inter, system-ui, sans-serif");
      }
    }

    /* ---------------- Loaders (dynamic import w/ cache bust) ---------------- */

    async function loadDesignSystem(slug) {
      const v = Date.now();
      const url = state.filesBase + '/design-systems/' + encodeURIComponent(slug) + '/tokens.js?v=' + v;
      const mod = await import(url);
      return mod.BRAND;
    }
    async function loadPage(slug, dsSlug) {
      const v = Date.now();
      // sections.js and page.js are non-negotiable — we cannot render
      // anything without them. tokens.js is best-effort: if the DS the
      // page is bound to was deleted (legacy page, manual cleanup, slug
      // typo from the agent), we degrade gracefully and keep the current
      // brand variables instead of blowing up the host.
      const [sectionsMod, pageMod] = await Promise.all([
        import(state.filesBase + '/pages/' + encodeURIComponent(slug) + '/sections.js?v=' + v),
        import(state.filesBase + '/pages/' + encodeURIComponent(slug) + '/page.js?v=' + v),
      ]);
      let brand = null;
      try {
        const tokensMod = await import(state.filesBase + '/design-systems/' + encodeURIComponent(dsSlug) + '/tokens.js?v=' + v);
        brand = tokensMod.BRAND;
      } catch (err) {
        console.warn('[host] design system "' + dsSlug + '" not found — using current brand', err);
      }
      return { brand, Sections: sectionsMod, blocks: pageMod.PAGE || [] };
    }

    /* ---------------- Mode crossfade ---------------- */

    async function crossfade(work) {
      stage.dataset.fading = 'true';
      await new Promise((r) => setTimeout(r, 220));
      await work();
      stage.dataset.fading = 'false';
    }

    /* ---------------- Rendering ---------------- */

    function rerender() {
      let view;
      if (state.mode === 'welcome')  view = h(WelcomeQuiz, {});
      else if (state.mode === 'page') view = h(PageView, {});
      else if (state.mode === 'ds-grid') view = h(DSGridView, {});
      else if (state.mode === 'empty') view = h(EmptyView, { label: state.emptyLabel || null });
      else view = null;
      render(view, stage);
    }

    /* ---- PageView: the single "build mode" view ----
     *
     * Layout (top → bottom):
     *   1. OutlineStepper        sticky, only when state.outline is set
     *   2. <main> content:
     *      - sections if blocks > 0
     *      - else UnifiedDesignPhase (DS gallery + section library
     *        split-screen) if a brand is loaded
     *      - else empty
     *
     * There is no separate "design-system demo" view anymore. The
     * unified design phase renders inline as the page's content while
     * blocks are empty — sections take over as they land. This
     * eliminates the jarring DS-demo → page-mode transition.
     */

    function PageView() {
      const blocks = state.blocks || [];
      const outline = state.outline || [];

      // === Phase first (raw, no pin) ===
      // Three live phases:
      //   prelude   — no real DS yet. We render the UnifiedDesignPhase
      //               with DEFAULT_PRELUDE_BRAND so the canvas always
      //               has something styled to show.
      //   design    — real DS landed; the split-screen UnifiedDesignPhase
      //               shows DS gallery on the left + section library
      //               with the agent's outline highlighted on the right.
      //               Floor = held for designFloor even if blocks
      //               arrive (deferred); ceil = exit at designCeil
      //               when no block has arrived yet.
      //   layout    — Floor and ceil elapsed, no body sections yet.
      //   building  — body sections landing.
      const now = Date.now();
      const designFloorEnds = state.dsArrivedAt
        ? state.dsArrivedAt + PHASE_MIN_MS.designFloor
        : 0;
      const designCeilEnds = state.dsArrivedAt
        ? state.dsArrivedAt + PHASE_MIN_MS.designCeil
        : 0;
      let livePhase;
      if (!state.brand) {
        livePhase = 'prelude';
      } else if (now < designFloorEnds) {
        // Below the floor — always show the design phase, regardless
        // of whether blocks have arrived (they sit deferred in
        // state.deferredRenderBlocks).
        livePhase = 'design';
      } else if (now < designCeilEnds && blocks.length === 0) {
        // Past the floor, below the ceiling, no blocks landed yet
        // — keep the design view up while we wait.
        livePhase = 'design';
      } else if (blocks.length === 0) {
        livePhase = 'layout';
      } else {
        livePhase = 'building';
      }

      // Stepper steps: index 0 = "Design", indices 1..N = outline[0..N-1].
      // The single "Design" step covers the unified DS + library phase.
      //
      // livePos: stepperIdx currently in progress. Capped at
      // outline.length (Footer's stepper index).
      const hasOutlineSteps = outline.length > 0;
      const livePos = !hasOutlineSteps
        ? 0
        : livePhase === 'prelude' || livePhase === 'design'
          ? 0
          : Math.min(blocks.length + 1, outline.length);

      // Schedule rerenders at upcoming phase boundaries so the UI
      // advances even if no further tool calls arrive.
      if (livePhase === 'design') {
        // Two boundaries to potentially fire: floor (when deferred
        // blocks can be released) and ceil (the hard exit).
        if (designFloorEnds > now) scheduleRerenderAt(designFloorEnds);
        if (designCeilEnds > now) scheduleRerenderAt(designCeilEnds);
      }

      // viewStepIdx: number set by clicking a stepper step. null means
      // "follow live". The stepper is a time-travel cursor — done/current
      // steps are clickable and pin the right-pane to that historical view
      // while the agent keeps working in the background.
      const isLive = state.viewStepIdx == null;
      // Clamp viewStepIdx to what's actually reachable. If the user pinned
      // step 4 when only 2 sections had landed, then a refresh shrank the
      // outline, we don't want a broken view.
      const safeView = isLive ? livePos
        : Math.max(0, Math.min(state.viewStepIdx, livePos));
      // Stepper layout: index 0 = Design, 1..N = outline.
      // So pinned stepperIdx=1 means "1 block visible (Nav)", index N
      // means "all N blocks visible". For the Design step no blocks
      // show. For live, all blocks show.
      const visibleBlockCount = isLive
        ? blocks.length
        : Math.max(0, Math.min(safeView, blocks.length));
      const visibleBlocks = blocks.slice(0, visibleBlockCount);

      // For pinned views, derive the phase from the pinned step index.
      // For live, use livePhase computed above.
      const buildPhase = isLive
        ? livePhase
        : safeView <= 0
          ? (state.brand ? 'design' : 'prelude')
          : 'building';

      // Stepper visibility — show ONLY when there's something live to
      // report. Three conditions any of which keeps it visible:
      //   1. state.isRunning      — agent is building, show progress
      //   2. !isLive              — user pinned a past step, show so
      //                              they can click "Live" to come back
      //   3. recent build ended   — settle window after isRunning flips
      //                              false; gives the user a final beat
      //
      // When none of these hold (e.g. user just navigated to an existing
      // page outside of any task), the stepper hides. Previously the
      // logic kept it visible by default, which meant opening a page
      // from the dropdown left a stale stepper at the top — the
      // "leaves the topbar progress incorrectly" bug.
      const inSettleWindow =
        !!state.buildEndedAt && now < state.buildEndedAt + STEPPER_SETTLE_MS;
      const showStepper = state.isRunning || !isLive || inSettleWindow;
      // Schedule a rerender at the stepper settle boundary so the fade
      // actually fires when the build ends with no further tool calls.
      const stepperSettling =
        !showStepper && !!state.buildEndedAt && !state.isRunning;
      // Schedule a rerender at the stepper settle boundary so the fade
      // actually fires when the build ends with no further tool calls.
      if (isLive && !state.isRunning && state.buildEndedAt) {
        const settleAt = state.buildEndedAt + STEPPER_SETTLE_MS;
        if (now < settleAt) scheduleRerenderAt(settleAt);
      }

      // Steps for the stepper. When the outline hasn't arrived yet we
      // show a single shimmering "Designing…" placeholder so the user
      // has a "we're on it" anchor in the first second of the build.
      const stepperSteps = outline.length > 0
        ? ['Design', ...outline]
        : ['Designing…'];
      const stepperLivePos = outline.length > 0
        ? livePos
        : (state.isRunning ? 0 : 1);
      const stepperViewIdx = !isLive && outline.length > 0 ? safeView : null;
      const stepperShimmer = outline.length === 0;

      function pickStep(idx) {
        // Click the step we're already viewing → release back to live.
        if (idx === state.viewStepIdx) {
          state.viewStepIdx = null;
        } else {
          // Pin to the chosen step. Pinning to livePos (the live cursor) is
          // semantically the same as "live" — fold into null so we keep
          // following along automatically as new sections land.
          state.viewStepIdx = idx === livePos ? null : idx;
        }
        rerender();
      }

      // The stepper sits on top of every phase. The body below it morphs
      // through prelude → design → layout → building → done without
      // remounting the chrome — only <main> swaps content.
      const stepperHtml = showStepper ? html\`<\${OutlineStepper}
        steps=\${stepperSteps}
        livePos=\${stepperLivePos}
        viewIdx=\${stepperViewIdx}
        isRunning=\${state.isRunning}
        onPick=\${pickStep}
        shimmer=\${stepperShimmer}
        settling=\${stepperSettling}
      />\` : null;

      // PRELUDE + DESIGN share the same render tree: the unified
      // split-screen design phase beneath the stepper. In prelude (no
      // real brand yet) we mount it with DEFAULT_PRELUDE_BRAND so the
      // canvas always has something styled to look at. When the real
      // DS lands, applyBrand() updates :root CSS variables; the
      // gallery's swatches and typography transition smoothly to the
      // new brand — no remount, no fade-out/in, just colors morphing.
      if (buildPhase === 'prelude' || buildPhase === 'design') {
        const galleryBrand = state.brand || DEFAULT_PRELUDE_BRAND;
        const galleryName = buildPhase === 'prelude'
          ? 'Default style'
          : (state.pageDsName || state.pageDsSlug || galleryBrand.name || '');
        return html\`<div class="page-shell">
          \${stepperHtml}
          <main key="design" class="page-main page-main-ds">
            <\${UnifiedDesignPhase}
              brand=\${galleryBrand}
              dsName=\${galleryName}
              outline=\${outline}
            />
          </main>
        </div>\`;
      }

      // Sections render in ARRIVAL ORDER, top-to-bottom — Nav first,
      // Footer last, everything else in between. No special-case sort.
      // The agent ships sections in outline order; queueReveal (see
      // host:render-block handler) reveals one section every
      // MIN_REVEAL_INTERVAL_MS so the page assembles deliberately
      // even when the agent emits RENDER_BLOCKs in parallel. If the agent ever
      // ships out of order, the visual order on the page is whatever
      // they shipped — no Footer-pinning trickery.

      // Active review tips = those Studio dispatched and the user
      // hasn't dismissed locally. Filtered once here so every block can
      // peek at the same set without re-allocating.
      const activeTips = (state.reviewTips || []).filter(
        (t) => !state.dismissedTipIds.has(t.id),
      );
      // Track which sections have already been claimed by a tip — when
      // the agent emits multiple tips for the same section (or no
      // matching block exists), each tip anchors to the FIRST matching
      // block by name, in order. Tips with no matching block fall back
      // to the action bar (rendered at the top of the page).
      //
      // Match is CASE-INSENSITIVE — the agent occasionally normalizes
      // section names ("hero" instead of "Hero"). Without case
      // collapsing, those tips wouldn't anchor and the user would only
      // see the bulk Accept-all bar (the "tips never appeared" bug).
      const claimedTipIdsBySection = new Map();
      for (const tip of activeTips) {
        const key = String(tip.section || '').toLowerCase();
        if (!claimedTipIdsBySection.has(key)) {
          claimedTipIdsBySection.set(key, tip);
        }
      }

      function renderBlock(block, i) {
        const Section = state.Sections[block.section];
        // Reveal key by section name + index — a polish refresh changes
        // props but keeps the same name + index; the section should stay
        // in place, not re-animate.
        const key = block.section + ':' + i;
        const seen = seenSectionKeys.has(key);
        seenSectionKeys.add(key);
        const cls = seen ? '' : 'section-enter';
        // Pull the first tip targeting this section name (case-insensitive
        // — see above). We claim it and remove from the map so the next
        // block with the same name doesn't double-attach. Tips left over
        // after rendering all blocks fall through to the action bar's
        // Accept-all flow.
        const tipKey = String(block.section || '').toLowerCase();
        const tip = claimedTipIdsBySection.get(tipKey);
        if (tip) claimedTipIdsBySection.delete(tipKey);
        const tipHtml = tip ? html\`<\${ReviewTip} tip=\${tip} />\` : null;
        if (!Section) {
          return html\`<div class=\${'section-wrapper ' + cls} data-section=\${block.section} style="padding:32px;color:#f87171;">Unknown section: \${block.section}\${tipHtml}</div>\`;
        }
        return html\`<\${SectionBoundary} name=\${block.section}>
          <div class=\${'section-wrapper ' + cls} data-section=\${block.section}>
            <\${Section} brand=\${state.brand} ...\${block.props || {}} />
            \${tipHtml}
          </div>
        </\${SectionBoundary}>\`;
      }

      const showActionsBar = activeTips.length > 0;

      // No ShellNav / ShellFooter fallbacks. The page is exactly what the
      // agent has shipped, in arrival order — Nav at top when shipped,
      // Footer at bottom when shipped, nothing phantom in between.
      return html\`<div class="page-shell">
        \${stepperHtml}
        \${showActionsBar ? html\`<\${ReviewActionsBar} tips=\${activeTips} />\` : null}
        <main key=\${'view:' + (state.viewStepIdx == null ? 'live' : 'pin-' + state.viewStepIdx)} class=\${'page-main' + (
          outline.length > 0 && state.blocks.length >= outline.length ? ' is-done' : ''
        )}>
          \${visibleBlocks.map((b, i) => renderBlock(b, i))}
        </main>
      </div>\`;
    }

    /* ---- ReviewTip: floating glassy tooltip attached to a section.
     *      Accept = bubble the suggestion's prompt to the parent (Studio
     *      composes + submits it in the chat input). Dismiss = local
     *      removal via state.dismissedTipIds. */
    function ReviewTip({ tip }) {
      function onAccept() {
        // Bubble to Studio: compose + auto-submit. Also dismiss locally
        // so the tooltip vanishes immediately on click (don't wait for
        // a stream round-trip).
        parent.postMessage({ type: 'page-editor:prompt-and-send', text: tip.prompt }, '*');
        state.dismissedTipIds.add(tip.id);
        rerender();
      }
      function onDismiss() {
        state.dismissedTipIds.add(tip.id);
        rerender();
      }
      return html\`<div class="review-tip" role="dialog" aria-label=\${'Suggestion for ' + tip.section}>
        <div class="review-tip-eyebrow">Suggestion · \${tip.section}</div>
        <div class="review-tip-text">\${tip.prompt}</div>
        <div class="review-tip-actions">
          <button type="button" class="review-tip-btn review-tip-accept" onClick=\${onAccept}>✓ Accept</button>
          <button type="button" class="review-tip-btn review-tip-dismiss" onClick=\${onDismiss}>✕ Dismiss</button>
        </div>
      </div>\`;
    }

    /* ---- ReviewActionsBar: sticky chip below the stepper offering
     *      Accept all / Dismiss all when at least one review tip is
     *      live. Accept all joins remaining tip prompts into one
     *      message (with section attribution) and sends in one shot. */
    function ReviewActionsBar({ tips }) {
      const count = tips.length;
      function onAcceptAll() {
        if (tips.length === 0) return;
        // Compose all remaining suggestions into one user-facing prompt
        // so the agent gets a single round-trip to enact them.
        const combined = 'Please apply these improvements:\\n\\n' +
          tips.map((t, i) => (i + 1) + '. ' + t.prompt).join('\\n');
        parent.postMessage({ type: 'page-editor:prompt-and-send', text: combined }, '*');
        for (const t of tips) state.dismissedTipIds.add(t.id);
        rerender();
      }
      function onDismissAll() {
        for (const t of tips) state.dismissedTipIds.add(t.id);
        rerender();
      }
      return html\`<div class="review-actions-bar" aria-label="Review suggestions actions">
        <div class="review-actions-chip">
          <span class="review-actions-label">\${count} suggestion\${count === 1 ? '' : 's'}</span>
          <button type="button" class="review-actions-btn review-actions-accept" onClick=\${onAcceptAll}>✓ Accept all</button>
          <button type="button" class="review-actions-btn review-actions-dismiss" onClick=\${onDismissAll}>✕ Dismiss all</button>
        </div>
      </div>\`;
    }

    /* ---- Outline stepper: agent-declared section plan + time-travel cursor.
     *
     * Each step is a button. "Done" and "current" steps are clickable —
     * clicking pins the right-pane preview to that historical snapshot
     * while the agent keeps working in the background. "Planned" steps
     * (still ahead of the live cursor) are inert; you can't time-travel
     * to a future that hasn't happened.
     *
     * When pinned to a past step, a "Live ›" pill appears at the end of
     * the row so the user always has one click back to following along.
     *
     * Props:
     *   steps    — string[]  e.g. ['Design system', 'Hero', 'Features', …]
     *   livePos  — number    stepperIdx where the build cursor currently is
     *   viewIdx  — number|null  pinned stepperIdx, or null if following live
     *   isRunning— boolean   whether the agent is still working
     *   onPick   — (idx) => void  click handler (passes the chosen idx)
     *   shimmer  — boolean   render each step as an inert shimmering pill
     *                         (used when outline hasn't been declared yet)
     *   settling — boolean   true once the build finished and we're holding
     *                         the stepper for STEPPER_SETTLE_MS before fading */

    function OutlineStepper({ steps, livePos, viewIdx, isRunning, onPick, shimmer, settling }) {
      const isLive = viewIdx == null;
      return html\`<div class="toc-wrap" aria-label="Page build outline" data-settling=\${settling ? 'true' : 'false'}>
        <div class="toc-row">
          \${steps.map((label, i) => {
            if (shimmer) {
              // Pre-outline: every step is an inert shimmering pill. No
              // states (done/current/planned) apply.
              return html\`<\${Fragment} key=\${i}>
                \${i > 0 ? html\`<span class="toc-sep" aria-hidden="true"></span>\` : null}
                <button type="button" class="toc-item toc-item-shimmer" disabled>
                  <span class="toc-dot" aria-hidden="true"></span>
                  <span>\${label}</span>
                </button>
              </\${Fragment}>\`;
            }
            const isDone = i < livePos;
            const isCurrent = i === livePos && isRunning;
            const isPlanned = i > livePos || (i === livePos && !isRunning && !isLive);
            const isViewing = !isLive && i === viewIdx;
            const clickable = (isDone || isCurrent) && !isViewing;
            const cls = [
              'toc-item',
              isViewing ? 'toc-item-viewing' :
                isDone ? 'toc-item-done' :
                  isCurrent ? 'toc-item-current' : 'toc-item-planned',
              clickable ? 'toc-item-clickable' : '',
              !isLive && i < livePos && !isViewing ? 'toc-item-rewindable' : '',
            ].filter(Boolean).join(' ');
            return html\`<\${Fragment} key=\${i}>
              \${i > 0 ? html\`<span class="toc-sep" aria-hidden="true"></span>\` : null}
              <button type="button"
                class=\${cls}
                disabled=\${isPlanned}
                aria-current=\${isCurrent ? 'step' : isViewing ? 'true' : null}
                title=\${isViewing ? 'Viewing this step (click "Live" to follow along)'
                  : clickable ? 'Rewind preview to this step'
                    : 'Not built yet'}
                onClick=\${clickable ? () => onPick(i) : undefined}>
                <span class="toc-dot" aria-hidden="true"></span>
                <span>\${label}</span>
              </button>
            </\${Fragment}>\`;
          })}
          \${!isLive ? html\`<\${Fragment}>
            <span class="toc-sep" aria-hidden="true"></span>
            <button type="button"
              class="toc-item toc-item-live toc-item-clickable"
              onClick=\${() => onPick(livePos)}
              title="Return to live build">
              <span class="toc-dot" aria-hidden="true"></span>
              <span>Live ›</span>
            </button>
          </\${Fragment}>\` : null}
        </div>
      </div>\`;
    }

    class SectionBoundary extends Component {
      constructor(p) { super(p); this.state = { err: null }; }
      static getDerivedStateFromError(err) { return { err }; }
      componentDidCatch(err) { console.error('[host] section error', this.props.name, err); }
      render() {
        if (this.state.err) {
          return html\`<div style="padding:16px 24px;margin:12px 24px;background:rgba(255,0,0,0.06);color:#b91c1c;border:1px solid rgba(255,0,0,0.2);border-radius:8px;font-family:ui-monospace,monospace;font-size:12px;line-height:1.5;">
            <strong>Section "\${this.props.name}" failed:</strong> \${String(this.state.err && this.state.err.message || this.state.err)}
          </div>\`;
        }
        return this.props.children;
      }
    }

    /* ---- Section library: 24 templates in 8 functional categories.
     *      Shown between the DS gallery phase and the building phase so
     *      the user sees the full range of what the agent could pick
     *      from, with the chosen sections highlighted. */
    const SECTION_CATEGORIES = [
      { label: 'Structure',    items: ['Nav', 'Footer', 'Banner'] },
      { label: 'Pitch',        items: ['Hero', 'CTASection', 'ProblemSolution', 'BeforeAfter'] },
      { label: 'Social proof', items: ['LogoStrip', 'StatStrip', 'TestimonialQuote', 'TestimonialGrid'] },
      { label: 'Features',     items: ['FeatureGrid', 'Steps', 'Comparison'] },
      { label: 'Commerce',     items: ['PricingCards', 'EmailCapture'] },
      { label: 'Trust',        items: ['FAQ', 'Callout'] },
      { label: 'Narrative',    items: ['Byline', 'KeyTakeaways', 'LongFormBody', 'Timeline'] },
      { label: 'Data',         items: ['MetricsGrid', 'Chart'] },
    ];
    const TOTAL_LIBRARY_SECTIONS = SECTION_CATEGORIES.reduce((n, c) => n + c.items.length, 0);

    /* ---- UnifiedDesignPhase: split-screen DS gallery + section
     *      library showcase. Renders during the unified 'design' phase
     *      (both prelude and real-brand) as a single board: DS preview
     *      on the left, section library with the agent's picks
     *      highlighted on the right. Replaces the previous two-beat
     *      DS-then-library sequence. */
    function UnifiedDesignPhase({ brand, dsName, outline }) {
      const b = brand || {};
      const colors = [
        ['primary', b.primary], ['secondary', b.secondary], ['accent', b.accent], ['bg', b.bg],
        ['surface', b.surface], ['fg', b.fg], ['muted', b.muted], ['border', b.border],
      ];
      const selected = new Set(Array.isArray(outline) ? outline : []);
      // Stagger the highlight animation across selected pills so they
      // pop in one-by-one as the user reads the categories. 160 ms gap
      // gives a 4-pill sequence ~640 ms total — short enough to feel
      // crisp, long enough that the user can register what's selected.
      // Begin after a 250 ms hold so the user first sees the board
      // settle in its gray-pill resting state before the highlights
      // start firing.
      const STAGGER_START_MS = 250;
      const STAGGER_STEP_MS = 160;
      let selectedOrdinal = 0;
      return html\`
        <div class="up-board">
          <header class="up-header">
            <span class="up-title">\${dsName || b.name || 'Default style'}</span>
            <span class="up-tag">
              Style preview · the agent picked \${selected.size} of \${TOTAL_LIBRARY_SECTIONS} sections
            </span>
          </header>
          <div class="up-split">
            <section class="up-ds">
              <div class="up-band">
                <p class="ds-eyebrow">Color palette</p>
                <div class="ds-palette">
                  \${colors.map(([name, value]) => html\`
                    <div class="swatch">
                      <div class="swatch-chip" style=\${'background:' + (value || '#888')}></div>
                      <span class="swatch-name">\${name}</span>
                      <span class="swatch-hex">\${value || ''}</span>
                    </div>
                  \`)}
                </div>
              </div>

              <div class="up-band">
                <p class="ds-eyebrow">Typography</p>
                <div class="ds-typo-stack">
                  <div>
                    <p class="typo-meta">Display · heading font</p>
                    <div class="heading" style="font-size: var(--text-3xl); line-height: 1.05;">Display heading</div>
                  </div>
                  <div>
                    <p class="typo-meta">Body · 16 px</p>
                    <p style="font-size: var(--text-base); line-height: 1.55; margin: 0; max-width: 56ch;">Body copy reads at 16 px with a comfortable line height — this is the default for paragraphs across every section bound to this design system.</p>
                  </div>
                  <div>
                    <p class="typo-meta">Caption · 14 px muted</p>
                    <p style="font-size: var(--text-sm); color: var(--brand-muted); margin: 0;">Used for metadata, labels, and supporting copy throughout the page.</p>
                  </div>
                </div>
              </div>

              <div class="up-band">
                <p class="ds-eyebrow">Components</p>
                <div class="ds-components-stack">
                  <div>
                    <p class="ds-sub-eyebrow">Buttons</p>
                    <div class="ds-buttons">
                      <button class="btn btn-primary">Primary</button>
                      <button class="btn btn-secondary">Secondary</button>
                      <button class="btn btn-ghost">Ghost</button>
                    </div>
                  </div>
                  <div>
                    <p class="ds-sub-eyebrow">Form controls</p>
                    <div class="ds-form-row-controls">
                      <input class="input" placeholder="Text input" />
                      <select class="select"><option>Select an option…</option></select>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section class="up-library">
              <div class="up-lib-grid">
                \${SECTION_CATEGORIES.map(cat => html\`
                  <section class="sl-category">
                    <p class="sl-eyebrow">\${cat.label}</p>
                    <div class="sl-pills">
                      \${cat.items.map(name => {
                        const isOn = selected.has(name);
                        if (!isOn) {
                          return html\`<div class="sl-pill">
                            <span>\${name}</span>
                          </div>\`;
                        }
                        const delayMs = STAGGER_START_MS + selectedOrdinal * STAGGER_STEP_MS;
                        selectedOrdinal += 1;
                        return html\`<div class="sl-pill sl-pill-on" style=\${'animation-delay:' + delayMs + 'ms'}>
                          <span>\${name}</span>
                          <span class="sl-check">✓</span>
                        </div>\`;
                      })}
                    </div>
                  </section>
                \`)}
              </div>
            </section>
          </div>
        </div>
      \`;
    }

    /* ---- DSGridView: manage design systems ---- */

    function DSGridView() {
      const items = state.designSystems || [];
      return html\`
        <div class="dsg-wrap container">
          <div class="dsg-head">
            <div>
              <p class="ds-eyebrow">Manage</p>
              <h1 class="heading" style="font-size: var(--text-4xl); margin: 0;">Design systems</h1>
              <p style="color: var(--brand-muted); margin-top: 8px;">Pick one to apply to the current page, or hover for a preview.</p>
            </div>
            <button class="btn btn-ghost" onClick=\${() => parent.postMessage({ type: 'page-editor:host-close-ds-grid' }, '*')}>Close</button>
          </div>
          \${items.length === 0
            ? html\`<div class="card"><div style="color: var(--brand-muted);">No design systems yet. Ask the agent to create one.</div></div>\`
            : html\`<div class="dsg-grid">
                \${items.map(it => html\`
                  <button class="dsg-card" type="button" onClick=\${() => parent.postMessage({ type: 'page-editor:host-select-ds', slug: it.slug }, '*')}>
                    <div class="dsg-swatches">
                      <div style=\${'flex:1;background:' + (it.brand?.primary || '#888')}></div>
                      <div style=\${'flex:1;background:' + (it.brand?.secondary || '#888')}></div>
                      <div style=\${'flex:1;background:' + (it.brand?.accent || '#888')}></div>
                      <div style=\${'flex:1;background:' + (it.brand?.bg || '#222')}></div>
                      <div style=\${'flex:1;background:' + (it.brand?.surface || '#333')}></div>
                    </div>
                    <div class="dsg-name">\${it.name || it.slug}</div>
                    <div class="dsg-sub">\${it.slug}</div>
                  </button>
                \`)}
              </div>\`
          }
        </div>
      \`;
    }

    /* ---- EmptyView / loading shimmer ---- */

    function EmptyView({ label }) {
      return html\`
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:48px;">
          <div style="text-align:center;max-width:36ch;">
            <div class="empty-pulse"><span style="font-size:22px;">✦</span></div>
            <div class="heading" style="font-size: var(--text-2xl); margin: 0 0 var(--space-3);">\${label || 'Getting ready…'}</div>
            <p style="color: var(--brand-muted); font-size: var(--text-sm); margin: 0;">Sections appear here as the agent builds them.</p>
          </div>
        </div>
      \`;
    }

    /* ---- Welcome quiz (mode='welcome') ----
     *
     * Seven-question optional quiz. Each question has card options + an
     * optional free-text "details" slot. None of the questions are required;
     * the Generate prompt button is always live. The composer only emits
     * sentences for questions the user actually answered, and free-text
     * fragments wrap the user's words verbatim so Claude reads them as
     * ground truth rather than hint. Picks frame; free-text supplies
     * proper nouns and prevents template-default slop ("Build a beautiful
     * page.", fabricated "Trusted by 10,000+ teams"). */

    const QUIZ_QUESTIONS = [
      {
        id: 'kind', label: "I'm building",
        compose: (frag) => 'Build ' + frag + '.',
        options: [
          { id: 'landing',   emoji: '🌐', label: 'Landing page',         hint: 'Hero, features, CTA',          fragment: 'a landing page anchored on a hero, a features grid, social proof, and a single primary CTA' },
          { id: 'waitlist',  emoji: '✉️', label: 'Waitlist',              hint: 'Email capture is the hero',     fragment: 'a waitlist page where the email capture IS the hero, not a footer afterthought' },
          { id: 'pricing',   emoji: '💳', label: 'Pricing page',          hint: 'Tiers, comparison, FAQ',       fragment: 'a pricing page with 2–4 tiered plans, a feature comparison, and an FAQ that pre-empts buyer hesitation' },
          { id: 'demo',      emoji: '🛠️', label: 'Product demo',          hint: 'Show, then explain',           fragment: 'a product demo page that leads with a working example and explains it after, not before' },
          { id: 'portfolio', emoji: '🎨', label: 'Portfolio',             hint: 'Bio + selected work',          fragment: 'a personal portfolio: short bio, a curated grid of real project titles, contact CTA' },
          { id: 'event',     emoji: '📅', label: 'Event page',            hint: 'Date, speakers, RSVP',         fragment: 'an event page with date, location, schedule, speakers, and a prominent RSVP CTA' },
          { id: 'launch',    emoji: '🚀', label: 'Launch / changelog',    hint: 'Story-shaped announcement',    fragment: 'a launch announcement page that reads like a story — hero claim, what is new, a next-step CTA' },
        ],
      },
      {
        id: 'product', label: 'The product is',
        compose: (frag) => 'It is ' + frag + '.',
        details: {
          placeholder: 'Real name, one sentence on what it actually does, proper nouns to mention (people, integrations, places)…',
          wrap: (txt) => 'The specifics — use as source of truth for hero copy and namedrops: "' + txt + '"',
        },
        options: [
          { id: 'saas',      emoji: '☁️', label: 'A SaaS tool',           hint: 'Software people log into',       fragment: 'a SaaS product — describe what the user does in it on day one, not just the category' },
          { id: 'devtool',   emoji: '⌨️', label: 'A dev tool / API',      hint: 'CLI, SDK, infra',                fragment: 'a developer tool — speak the audience\\'s language (latency, types, repos) and show a real code or config snippet' },
          { id: 'ai',        emoji: '🤖', label: 'An AI app',              hint: 'LLM / agent product',            fragment: 'an AI product — show what it does with one specific input and output, never the phrase "powered by AI"' },
          { id: 'physical',  emoji: '📦', label: 'A physical product',     hint: 'Something you ship',             fragment: 'a physical product — lead with what it feels like to use, not the spec sheet' },
          { id: 'agency',    emoji: '🧑‍🎨', label: 'An agency / studio',   hint: 'Services for hire',              fragment: 'an agency or studio — name the discipline and show real client outcomes, not adjectives' },
          { id: 'creator',   emoji: '🎙️', label: 'A creator project',     hint: 'Newsletter, course, podcast',    fragment: 'a creator project — the maker\\'s voice and point of view is the product' },
          { id: 'community', emoji: '🏛️', label: 'A community / event',   hint: 'People + place',                 fragment: 'a community or recurring event — make the reader want to be in the room' },
        ],
      },
      {
        id: 'audience', label: 'Written for',
        compose: (frag) => 'Audience: ' + frag + '.',
        details: {
          placeholder: 'What are they using today that you want to replace? (e.g. "spreadsheets", "Notion", "a Fiverr designer")',
          wrap: (txt) => 'They are currently coping with: "' + txt + '" — make that pain visible without naming competitors unkindly',
        },
        options: [
          { id: 'devs',       emoji: '👩‍💻', label: 'Developers',          hint: 'Code, APIs, terminals',          fragment: 'developers — assume technical literacy, show code, never explain what an API is, no exclamation marks' },
          { id: 'designers',  emoji: '🎨', label: 'Designers',              hint: 'Visual-first, taste-driven',     fragment: 'designers — visual polish carries half the message, copy can be sparser and more considered' },
          { id: 'founders',   emoji: '🚀', label: 'Founders / operators',   hint: 'Outcomes, ROI, time saved',       fragment: 'founders and operators — lead with the outcome (time saved, revenue lifted) before the mechanism' },
          { id: 'enterprise', emoji: '🏢', label: 'Enterprise buyers',      hint: 'Security, evidence, procurement', fragment: 'enterprise buyers — emphasize security, references, and concrete logos; bury the playful tone' },
          { id: 'indie',      emoji: '🧰', label: 'Indie / prosumers',      hint: 'Curious, hands-on',               fragment: 'indie makers and prosumers — assume curiosity and willingness to tinker' },
          { id: 'consumers',  emoji: '🛒', label: 'Mainstream consumers',   hint: 'Friendly, scannable',             fragment: 'general consumers — short sentences, recognizable references, one obvious CTA' },
          { id: 'creators',   emoji: '🎬', label: 'Creators / community',   hint: 'Vibe-first, expressive',          fragment: 'creators — community-first framing, expressive design, soft CTAs ("Join", "Start")' },
        ],
      },
      {
        id: 'goal', label: 'One goal',
        compose: (frag) => 'Desired action: ' + frag,
        details: {
          placeholder: 'Exact button label, if you have one in mind (e.g. "Start free trial", "Get early access")',
          wrap: (txt) => 'Use this EXACT CTA label on the primary button: "' + txt + '"',
        },
        options: [
          { id: 'signup',   emoji: '✨', label: 'Sign up free',     hint: 'Self-serve product',     fragment: 'primary CTA is "Sign up free" or a product-specific equivalent — put an EmailCapture or signup button above the fold.' },
          { id: 'demo',     emoji: '🤝', label: 'Book a demo',      hint: 'Sales-led',              fragment: 'primary CTA is "Book a demo"; include TestimonialQuote and LogoStrip to justify the meeting ask.' },
          { id: 'waitlist', emoji: '⏳', label: 'Join the waitlist', hint: 'Pre-launch',             fragment: 'primary CTA is "Join the waitlist" and the EmailCapture is the dominant element; suppress pricing.' },
          { id: 'buy',      emoji: '🛍️', label: 'Buy now',          hint: 'Direct purchase',        fragment: 'primary CTA is "Buy now" / "Get [product]"; include price above the fold and a guarantee or refund line near the CTA.' },
          { id: 'contact',  emoji: '✉️', label: 'Contact us',       hint: 'Bespoke / enterprise',   fragment: 'primary CTA is "Get in touch"; no self-serve elements — lean on TestimonialQuote and case-study FeatureGrid.' },
          { id: 'read',     emoji: '📖', label: 'Read / explore',   hint: 'Content discovery',      fragment: 'primary CTA is soft ("Read more", "Browse"); skip EmailCapture unless explicitly asked.' },
          { id: 'rsvp',     emoji: '🎟️', label: 'RSVP / register',  hint: 'Event',                  fragment: 'primary CTA is "RSVP" / "Register"; surface date, location, and capacity (if relevant) above the fold.' },
        ],
      },
      {
        id: 'voice', label: 'Voice like',
        compose: (frag) => 'Voice: ' + frag + '.',
        details: {
          placeholder: 'Drop a link, a quote, or "sounds like ___" so the agent can match the register',
          wrap: (txt) => 'Voice reference from the user — pattern-match this register when writing every line of copy: "' + txt + '"',
        },
        options: [
          { id: 'stripe',    emoji: '📘', label: 'Stripe-clean',          hint: 'Precise, no hype',           fragment: 'voice like Stripe\\'s docs — precise, no hype words, every sentence earns its place' },
          { id: 'linear',    emoji: '➤',  label: 'Linear-terse',          hint: 'Short, opinionated',         fragment: 'voice like Linear — short declarative lines, strong opinions, near-zero adjectives' },
          { id: 'apple',     emoji: '🍎', label: 'Apple-poetic',          hint: 'Big claims, small words',    fragment: 'voice like an Apple keynote — short poetic claims, generous whitespace around each thought' },
          { id: 'vercel',    emoji: '▲',  label: 'Vercel-developer',       hint: 'Technical, slightly cocky',  fragment: 'voice like Vercel — technical confidence, dev-native vocabulary, dry humor' },
          { id: 'mailchimp', emoji: '🎈', label: 'Mailchimp-warm',         hint: 'Human, playful',             fragment: 'voice like Mailchimp / early Slack — warm, second-person, a little playful, never corporate' },
          { id: 'patagonia', emoji: '🌲', label: 'Patagonia-earnest',      hint: 'Plainspoken, values-forward',fragment: 'voice like Patagonia — plainspoken, values-forward, no marketing speak' },
          { id: 'substack',  emoji: '✍️', label: 'Substack-essayist',     hint: 'First-person, considered',   fragment: 'voice in a first-person essayist register like a good Substack — opinions, not pitches' },
        ],
      },
      {
        id: 'visual', label: 'Visual anchor',
        // Each option corresponds to one of the 10 curated themes from
        // DEFAULT_THEMES (apps/mesh/src/page-preview/default-themes.ts).
        // The fragment is phrased as a direct instruction to pass the
        // template slug to DESIGN_SYSTEM_CREATE so the agent skips the
        // freestyle palette decision and gets a contrast-checked DS in
        // one shot.
        compose: (frag) => 'Visual direction: ' + frag,
        options: [
          { id: 'dark-violet',      emoji: '🌌', label: 'Dark Violet',        hint: 'AI cinematic violet',           fragment: "use DESIGN_SYSTEM_CREATE with template: 'dark-violet' (cinematic violet on near-black, for AI/SaaS)." },
          { id: 'cyber-lime',       emoji: '🍋', label: 'Cyber Lime',         hint: 'Lime on graphite',              fragment: "use DESIGN_SYSTEM_CREATE with template: 'cyber-lime' (lime on graphite, hacker-meets-finance)." },
          { id: 'editorial-serif',  emoji: '📰', label: 'Editorial Serif',    hint: 'Magazine typography',           fragment: "use DESIGN_SYSTEM_CREATE with template: 'editorial-serif' (quiet luxury, DM Serif Display headings)." },
          { id: 'pastel-peach',     emoji: '🍑', label: 'Pastel Peach',       hint: 'Warm friendly B2B',             fragment: "use DESIGN_SYSTEM_CREATE with template: 'pastel-peach' (warm terracotta on cream, friendly B2B)." },
          { id: 'neon-retro',       emoji: '📼', label: 'Neon Retro 80s',     hint: 'Arcade flyer energy',           fragment: "use DESIGN_SYSTEM_CREATE with template: 'neon-retro' (arcade-flyer yellow + pink + cyan on black, Impact heading)." },
          { id: 'brutalist-mono',   emoji: '🧱', label: 'Brutalist Mono',     hint: 'Hard borders, monospace',       fragment: "use DESIGN_SYSTEM_CREATE with template: 'brutalist-mono' (cream bg, single hot accent, monospace headings, 0 radius)." },
          { id: 'sage-minimal',     emoji: '🌿', label: 'Sage Minimal',       hint: 'Hushed olive on paper',         fragment: "use DESIGN_SYSTEM_CREATE with template: 'sage-minimal' (hushed olive on warm paper)." },
          { id: 'glass-deep-sea',   emoji: '🌊', label: 'Glass Deep Sea',     hint: 'Teal on midnight navy',         fragment: "use DESIGN_SYSTEM_CREATE with template: 'glass-deep-sea' (teal glow over midnight navy, generous radius)." },
          { id: 'electric-indigo',  emoji: '💎', label: 'Electric Indigo',    hint: 'Crisp SaaS indigo',             fragment: "use DESIGN_SYSTEM_CREATE with template: 'electric-indigo' (crisp indigo on white, modern SaaS)." },
          { id: 'confetti-magenta', emoji: '🎊', label: 'Confetti Magenta',   hint: 'Pink + violet + yellow',        fragment: "use DESIGN_SYSTEM_CREATE with template: 'confetti-magenta' (hot pink + violet + yellow party energy)." },
        ],
      },
      {
        id: 'proof', label: 'Proof I have',
        compose: (frag) => 'Proof handling: ' + frag,
        details: {
          placeholder: 'Drop names, numbers, quotes, or snippet text EXACTLY as they should appear on the page',
          wrap: (txt) => 'Proof material to use VERBATIM (do not paraphrase, do not invent any additional names/numbers/quotes beyond this): "' + txt + '"',
        },
        options: [
          { id: 'logos',    emoji: '🏷️', label: 'Customer logos',     hint: 'Real names ready',         fragment: 'include a LogoStrip section using ONLY the customer or partner names supplied below.' },
          { id: 'numbers',  emoji: '📊', label: 'Numbers / traction', hint: 'Metrics to brag',           fragment: 'lead with a concrete metric in the Hero subtitle or a dedicated stat row, using ONLY numbers supplied below.' },
          { id: 'quote',    emoji: '💬', label: 'A real quote',       hint: 'Founder or customer',       fragment: 'include a TestimonialQuote attributed to the founder or a real customer, using ONLY the quote supplied below.' },
          { id: 'press',    emoji: '📰', label: 'Press / awards',     hint: 'Coverage to cite',          fragment: 'include a "featured in" LogoStrip of press / awards, using ONLY the publications supplied below.' },
          { id: 'snippet',  emoji: '💾', label: 'Code / config',      hint: 'Show, do not tell',         fragment: 'include a real code or config snippet in the hero or features area, using ONLY the snippet supplied below.' },
          { id: 'none',     emoji: '🚫', label: 'Nothing yet',        hint: 'Pre-launch — be honest',    fragment: 'skip LogoStrip and TestimonialQuote entirely. DO NOT fabricate customer names, quotes, or metrics. Replace with a "what we believe" or "why now" block.' },
        ],
      },
    ];

    function WelcomeQuiz() {
      const [pick, setPick] = useState({});
      const [details, setDetails] = useState({});

      function setDetail(qid, value) {
        setDetails((prev) => ({ ...prev, [qid]: value }));
      }

      // Compose the prompt from whatever the user actually answered.
      // Each card's compose() wraps the chosen fragment; each detail's
      // wrap() escapes the user's verbatim text. Anything skipped is
      // simply omitted — no scolding the user for an empty answer.
      function composedPrompt() {
        const parts = [];
        for (const q of QUIZ_QUESTIONS) {
          const chosen = pick[q.id] ? q.options.find((o) => o.id === pick[q.id]) : null;
          if (chosen) parts.push(q.compose(chosen.fragment));
          const detail = (details[q.id] || '').trim();
          if (detail && q.details && q.details.wrap) parts.push(q.details.wrap(detail));
        }
        if (parts.length === 0) {
          // No picks, no details — emit a minimal stub so the agent still has
          // a direction (the chat can refine from there).
          parts.push('Build a landing page.');
        }
        return parts.join(' ');
      }

      return html\`
        <div class="welcome-root">
          <main style="min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:56px 24px;">
            <p class="welcome-pill">Page Editor</p>
            <h1 class="welcome-h1" style="margin-top: 16px;">What do you want to build?</h1>
            <p class="welcome-sub">Answer as much or as little as you like — every question is optional. The more specifics you drop in the details, the less generic the page.</p>
            <div style="margin-top:40px;width:100%;max-width:1040px;display:flex;flex-direction:column;gap:28px;">
              \${QUIZ_QUESTIONS.map((q) => html\`
                <section style="display:flex;flex-direction:column;gap:12px;">
                  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;">
                    <div style="font-size:11px;letter-spacing:0.18em;color:rgba(255,255,255,0.55);text-transform:uppercase;">\${q.label}</div>
                    <div style="font-size:11px;color:rgba(255,255,255,0.35);">optional</div>
                  </div>
                  <div style="display:flex;flex-wrap:wrap;gap:12px;">
                    \${q.options.map((opt) => html\`
                      <button type="button"
                        class=\${'qcard' + (pick[q.id] === opt.id ? ' selected' : '')}
                        onClick=\${() => setPick({ ...pick, [q.id]: pick[q.id] === opt.id ? null : opt.id })}>
                        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
                          <div style="font-size:20px;">\${opt.emoji}</div>
                          <span class="qcheck">✓</span>
                        </div>
                        <div style="margin-top:12px;font-size:14px;font-weight:500;">\${opt.label}</div>
                        <div style="margin-top:4px;font-size:12px;color:rgba(255,255,255,0.55);">\${opt.hint}</div>
                      </button>
                    \`)}
                  </div>
                  \${q.details ? html\`
                    <textarea
                      rows="2"
                      placeholder=\${q.details.placeholder}
                      value=\${details[q.id] || ''}
                      onInput=\${(e) => setDetail(q.id, e.currentTarget.value)}
                      style="margin-top:4px;width:100%;border-radius:12px;padding:10px 14px;font-size:13px;color:rgba(255,255,255,0.92);background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);font-family:Inter,system-ui,sans-serif;resize:vertical;"
                    ></textarea>
                  \` : null}
                </section>
              \`)}
            </div>
            <button
              class="cta-pill"
              style="margin-top:32px;padding:12px 28px;border-radius:999px;background:#A595FF;color:#0A0A0F;font-weight:600;font-size:14px;border:0;cursor:pointer;font-family:Inter,system-ui,sans-serif;"
              onClick=\${() => parent.postMessage({ type: 'page-editor:prompt', text: composedPrompt() }, '*')}
            >Generate prompt →</button>
          </main>
        </div>
      \`;
    }


    /* ---------------- Scroll follow ---------------- */

    /**
     * After a refresh that introduced new section blocks, scroll the FIRST
     * newcomer into view so the user follows the build instead of having
     * to chase appended sections.
     *
     * Uses native scrollIntoView with block: 'center' so the section's
     * vertical center aligns with the viewport center — feels more like
     * "here's the new section" than "here's the top of the new section,
     * try to peek under the stepper." Skip the scroll when the newcomer
     * is already comfortably centered.
     */
    /**
     * Scroll a specific section into the vertical center of the viewport
     * by NAME. Uses scrollIntoView({ block: 'center' }) on the actual
     * element — no manual math, no querying .section-enter (which gets
     * stripped by animationend and isn't a stable identifier anyway).
     *
     * The 200ms delay gives:
     *   - preact a paint cycle to commit the new DOM,
     *   - the entry animation's first frames time to settle so the
     *     element's getBoundingClientRect is accurate at scroll time.
     * The 100vh bottom spacer on .page-main guarantees there's room to
     * actually center the section, even when it's the last in the page.
     */
    function scrollSectionToCenter(sectionName) {
      if (!sectionName) return;
      setTimeout(() => {
        const el = stage.querySelector('[data-section="' + sectionName + '"]');
        if (!el || !el.isConnected) {
          console.debug('[host scroll] missing element for', sectionName);
          return;
        }
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        console.debug('[host scroll] center →', sectionName, el.getBoundingClientRect());
        el.scrollIntoView({
          block: 'center',
          behavior: reduce ? 'auto' : 'smooth',
        });
      }, 200);
    }

    /**
     * Scroll the iframe back to the top. Called when the build ends so the
     * user lands on the finished page from the top (Hero first), not
     * wherever the last newcomer-scroll left them.
     */
    function scrollIframeToTop() {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    }

    /* ---------------- Bridge ---------------- */

    async function setMode(mode, work) {
      resetReveal(); // mode change → new content gets entry animation
      state.viewStepIdx = null; // release any time-travel pin on mode swap
      // Welcome and thinking are pre-build states; reset the choreographed
      // loading timestamps so the next build's phasing starts fresh. Page
      // mode retains them (we want minimums to apply mid-build).
      if (mode === 'welcome') {
        state.dsArrivedAt = null;
        state.pageCreatedAt = null;
        state.firstBlockArrivedAt = null;
        state.buildEndedAt = null;
        state.deferredRenderBlocks = [];
        state.thinkingPrompt = null;
        lastRevealAt = 0;
      }
      await crossfade(async () => {
        if (work) await work();
        state.mode = mode;
        if (window.__pe_host_clear_error) window.__pe_host_clear_error();
        rerender();
      });
    }

    window.addEventListener('message', async (e) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object') return;
      // Any incoming Studio command implies the previous error (if any)
      // is no longer relevant — the user/agent has moved on. Clearing
      // upfront lets a successful retheme/refresh dismiss a stale card.
      const _wasErrored = !!document.getElementById('__host_error_card__');
      function _maybeClearError() {
        if (_wasErrored && window.__pe_host_clear_error) {
          window.__pe_host_clear_error();
        }
      }
      try {
        switch (msg.type) {
          case 'host:hello':
            if (msg.filesBase) state.filesBase = String(msg.filesBase);
            if (Array.isArray(msg.designSystems)) state.designSystems = msg.designSystems;
            break;
          case 'host:welcome':
            await setMode('welcome');
            break;
          case 'host:prelude': {
            // The agent has just started — render the prelude phase inside
            // page mode. No real DS yet; the UnifiedDesignPhase mounts
            // with DEFAULT_PRELUDE_BRAND so the canvas has something
            // styled to look at. When the real brand lands, CSS
            // variables transition smoothly and the gallery diffs in
            // place.
            //
            // Reset prior-build state but keep state.brand=null so the
            // PageView render falls into the prelude branch. We push the
            // default-brand CSS variables to :root explicitly so any
            // stale brand from a previous session is overwritten (the
            // iframe is reused across chats; without this the prelude
            // would inherit the last build's colors).
            state.thinkingPrompt = msg.prompt || '';
            state.dsArrivedAt = null;
            state.pageCreatedAt = null;
            state.firstBlockArrivedAt = null;
            state.buildEndedAt = null;
            state.deferredRenderBlocks = [];
            lastRevealAt = 0;
            state.brand = null;
            state.blocks = [];
            state.Sections = {};
            state.outline = null;
            state.pageSlug = null;
            state.pageDsSlug = null;
            state.pageDsName = null;
            // Drop any leftover review tips from a prior build so the
            // new run starts fresh.
            state.reviewTips = [];
            state.dismissedTipIds = new Set();
            const r = document.documentElement;
            for (const k of Object.keys(DEFAULT_PRELUDE_BRAND)) {
              const v = DEFAULT_PRELUDE_BRAND[k];
              if (v) r.style.setProperty('--brand-' + camelToKebab(k), v);
            }
            if (state.mode === 'page') {
              rerender();
            } else {
              await setMode('page');
            }
            break;
          }
          case 'host:empty':
            state.emptyLabel = msg.label || null;
            await setMode('empty');
            break;
          case 'host:show-design-system':
            // Enter page mode with the DS as the backdrop. <main> renders
            // an inline gallery while blocks is empty; as sections land
            // they replace the gallery. No more separate ds-demo mode.
            if (msg.brand) applyBrand(msg.brand);
            else if (msg.slug) {
              const brand = await loadDesignSystem(msg.slug);
              applyBrand(brand);
            }
            state.pageSlug = null;
            state.pageDsSlug = msg.slug || null;
            const dsEntryForShow = (state.designSystems || []).find((d) => d.slug === msg.slug);
            state.pageDsName = (dsEntryForShow && dsEntryForShow.name) || (state.brand && state.brand.name) || msg.slug || null;
            state.blocks = [];
            state.Sections = {};
            await setMode('page');
            break;
          case 'host:show-design-system-grid':
            if (Array.isArray(msg.designSystems)) state.designSystems = msg.designSystems;
            await setMode('ds-grid');
            break;
          case 'host:set-review-tips': {
            // Studio derives tips from the chat stream's PAGE_REVIEW_SUGGEST
            // calls and pushes them in. We dedupe against locally-dismissed
            // ids so a re-render of the same stream doesn't resurrect tips
            // the user already closed.
            const next = Array.isArray(msg.tips) ? msg.tips : [];
            state.reviewTips = next.filter((t) => t && typeof t === 'object' && t.id && t.section && t.prompt);
            if (state.mode === 'page') rerender();
            break;
          }
          case 'host:set-page':
            // Load the page (and its DS) and render. If we're already in
            // page mode (e.g. transitioning from inline-gallery to first
            // sections), rerender in-place without a full crossfade so the
            // shell/stepper/footer stay anchored and only the <main>
            // content swaps (gallery → sections).
            if (msg.slug && msg.designSystem) {
              const loaded = await loadPage(msg.slug, msg.designSystem);
              // REPL-write race guard: when set-page arrives for the same
              // slug we've been REPL-rendering into, prefer the in-memory
              // blocks. The disk write (writeBlocksToPageJs) is async and
              // fire-and-forget, so page.js on disk may still be empty or
              // partial at the moment the post-build intent flip fires
              // set-page. Loading disk's empty blocks would clobber the
              // user's just-built page. In-memory state is always at least
              // as fresh as disk for the slug we own.
              const sameSlug = state.pageSlug === msg.slug;
              const keepInMemoryBlocks = sameSlug && Array.isArray(state.blocks) && state.blocks.length > (loaded.blocks?.length || 0);
              // Slug-changed reset: navigating to a DIFFERENT page (or to
              // any page from welcome / ds-grid / empty) means the old
              // in-memory blocks are stale — they belong to a different
              // page. Without this reset the next host:render-block from
              // a fresh build would PUSH onto stale blocks → duplicates
              // (the "wtf duplicated sections" bug when refreshing). The
              // disk load below sets state.blocks = loaded.blocks; the
              // reset just makes it explicit and also clears section
              // component refs so a different page's sections.js doesn't
              // shadow.
              if (!sameSlug) {
                state.blocks = [];
                state.Sections = {};
                resetReveal();
              }
              state.pageSlug = msg.slug;
              state.pageDsSlug = msg.designSystem;
              const dsEntry = (state.designSystems || []).find((d) => d.slug === msg.designSystem);
              state.pageDsName = (dsEntry && dsEntry.name) || (loaded.brand && loaded.brand.name) || msg.designSystem;
              // Merge Section component refs: keep cached ones (stable refs
              // across refreshes), add new exports.
              for (const name of Object.keys(loaded.Sections || {})) {
                if (!(name in state.Sections)) {
                  state.Sections[name] = loaded.Sections[name];
                }
              }
              if (!keepInMemoryBlocks) {
                state.blocks = loaded.blocks || [];
              }
              if (loaded.brand) applyBrand(loaded.brand);
              // Skip the design phase choreography hold when navigating
              // to an EXISTING page (the page already has blocks on
              // disk). Otherwise the iframe would camp on the unified
              // design view for ~10 s before showing the page that's
              // right there in memory. Backdate dsArrivedAt so both
              // designFloorEnds and designCeilEnds are already in the
              // past at next render; livePhase goes straight to
              // 'building'.
              if ((loaded.blocks || []).length > 0) {
                state.dsArrivedAt = Date.now() - PHASE_MIN_MS.designCeil - 1000;
              }
              if (state.mode !== 'page') {
                await setMode('page');
              } else {
                // Already in page mode (came from inline gallery). Reset
                // section-reveal tracking so the new blocks animate in.
                resetReveal();
                rerender();
              }
              _maybeClearError();
            }
            break;
          case 'host:refresh-page':
            // Re-fetch current page and apply diff WITHOUT a mode change, so
            // only NEW blocks get the entry animation.
            if (state.pageSlug && state.pageDsSlug) {
              const loaded = await loadPage(state.pageSlug, state.pageDsSlug);
              // STABILIZE Section component references across refreshes.
              // Dynamic import always evaluates a fresh module instance, so
              // \`loaded.Sections.Hero\` is a brand-new function ref every
              // refresh — preact's reconciler sees a type change and
              // unmounts/remounts the inner DOM of every section. The user
              // perceives this as the section "disappearing" during the
              // polish refresh. By keeping the cached ref when the export
              // name already exists, we let preact diff in-place: the same
              // function component instance receives new props, re-renders
              // its template, but the DOM tree is preserved.
              for (const name of Object.keys(loaded.Sections || {})) {
                if (!(name in state.Sections)) {
                  state.Sections[name] = loaded.Sections[name];
                }
              }
              state.blocks = loaded.blocks || [];
              if (loaded.brand) applyBrand(loaded.brand);
              if (state.mode !== 'page') {
                await setMode('page');
              } else {
                rerender();
                // host:refresh-page is dispatched on every refreshNonce
                // bump, including when the agent's turn ends. Don't
                // scroll here — revealBlock's per-section centering and
                // the post-Footer scroll-to-top already manage the
                // viewport. An extra scroll here was causing the "scroll
                // up, then scroll back down to last section" double-jump
                // immediately after the final Footer landed.
              }
              _maybeClearError();
            }
            break;
          case 'host:retheme':
            // Apply a different DS's brand to the current page, no reload of
            // sections.js / page.js — just CSS variables transitioning.
            if (msg.slug) {
              const brand = await loadDesignSystem(msg.slug);
              applyBrand(brand);
            } else if (msg.brand) {
              applyBrand(msg.brand);
            }
            _maybeClearError();
            break;
          case 'host:update-design-systems':
            if (Array.isArray(msg.designSystems)) {
              state.designSystems = msg.designSystems;
              if (state.mode === 'ds-grid') rerender();
            }
            break;
          case 'host:set-page-progress': {
            // Studio pushes the live agent progress label, isRunning state,
            // and agent-declared outline. The host renders the inline
            // drafting slot + sticky stepper from these (the floating pill
            // overlay remains Studio's job — they serve different roles).
            state.progressLabel = typeof msg.label === 'string' && msg.label.trim() ? msg.label.trim() : null;
            const wasRunning = state.isRunning;
            state.isRunning = !!msg.isRunning;
            // Detect the running → idle transition: stamp buildEndedAt so the
            // stepper can hold for STEPPER_SETTLE_MS then fade out. A new
            // build starting (idle → running) clears the stamp.
            if (wasRunning && !state.isRunning) {
              // Build just ended at the agent layer. The scroll-to-top
              // already fired when the last RENDER_BLOCK revealed (see
              // revealBlock). Just stamp buildEndedAt so the stepper
              // enters its settle window.
              state.buildEndedAt = Date.now();
              scheduleRerenderAt(state.buildEndedAt + STEPPER_SETTLE_MS);
            } else if (!wasRunning && state.isRunning) {
              state.buildEndedAt = null;
            }
            state.outline = Array.isArray(msg.outline) ? msg.outline.filter((s) => typeof s === 'string' && s.trim()) : null;
            if (msg.buildState && typeof msg.buildState === 'object') {
              state.buildDesignSystem = msg.buildState.designSystem || null;
              const newlyCreated = !state.buildPageCreated && !!msg.buildState.pageCreated;
              state.buildPageCreated = !!msg.buildState.pageCreated;
              state.buildPageActivated = !!msg.buildState.pageActivated;
              if (newlyCreated) {
                // Stamp the layout phase start. We hold the unified
                // design view at least PHASE_MIN_MS.designFloor before
                // allowing the layout phase to take over.
                state.pageCreatedAt = Date.now();
                // Schedule a rerender at the design-floor boundary so
                // the UI transitions to the layout (shell + stubs)
                // view on time even without further tool calls.
                const designHoldUntil = (state.dsArrivedAt || Date.now()) + PHASE_MIN_MS.designFloor;
                scheduleRerenderAt(Math.max(Date.now(), designHoldUntil));
              }
              if (state.buildDesignSystem && state.buildDesignSystem.brand) {
                applyBrand(state.buildDesignSystem.brand);
              }
            }
            if (state.mode === 'page') rerender();
            break;
          }

          /* ----- Browser-as-REPL block patches (the fast path) -----
           *
           * Studio observes PAGE_RENDER_BLOCK / UPDATE_BLOCK / REMOVE_BLOCK
           * tool calls in the chat stream and dispatches these messages to
           * the iframe directly. No HTTP fetch, no dynamic import — we just
           * patch the in-memory state.blocks and rerender. Disk persistence
           * happens server-side in the background.
           *
           * If we're not yet in page mode (typically because the DS gallery
           * is showing), we flip to page mode so the first block lands
           * visibly. */
          case 'host:render-block': {
            if (!Array.isArray(state.blocks)) state.blocks = [];
            const block = {
              section: String(msg.section || ''),
              props: sanitizeBlockProps(msg.props || {}),
            };
            if (!block.section) break;
            // The REPL flow skips host:set-page entirely, so this iframe
            // never loaded sections.js for the page being built. Lazy-load
            // it here on the first render-block so the Section component
            // registry is populated. Without this, every block falls into
            // the "Unknown section: X" branch in PageView.
            const targetSlug = String(msg.slug || '') || state.pageSlug;
            const targetDsSlug = String(msg.designSystem || '') || state.pageDsSlug;
            // Slug-changed reset (BOOTSTRAP rebuild safeguard): if this
            // render-block targets a DIFFERENT page than what's in
            // memory, the old blocks belong to the previous build and
            // would duplicate when this new fresh build pushes onto
            // them.
            if (targetSlug && state.pageSlug && state.pageSlug !== targetSlug) {
              state.blocks = [];
              state.Sections = {};
              resetReveal();
            }
            const needsSectionsLoad =
              !state.Sections || Object.keys(state.Sections).length === 0;
            if (needsSectionsLoad && targetSlug && targetDsSlug) {
              try {
                const loaded = await loadPage(targetSlug, targetDsSlug);
                // Merge component refs: keep any already-cached (for
                // refresh-across-builds stability) and add the new
                // exports. seenSectionKeys reset only at mode change.
                for (const name of Object.keys(loaded.Sections || {})) {
                  if (!(name in state.Sections)) {
                    state.Sections[name] = loaded.Sections[name];
                  }
                }
                state.pageSlug = targetSlug;
                state.pageDsSlug = targetDsSlug;
                if (loaded.brand) applyBrand(loaded.brand);
              } catch (err) {
                console.warn('[host] lazy loadPage failed:', err);
              }
            }
            // Defer the reveal during the design phase floor window
            // so the user gets the full DS + library appreciation hold
            // even if the agent ships fast. After designFloor elapses,
            // drain the deferred queue through queueReveal so each
            // section gets MIN_REVEAL_INTERVAL_MS of breathing room.
            const designArrived = state.dsArrivedAt;
            const nowMs = Date.now();
            const designFloorEnds = designArrived
              ? designArrived + PHASE_MIN_MS.designFloor
              : 0;
            if (designArrived && nowMs < designFloorEnds) {
              state.deferredRenderBlocks.push(block);
              const remaining = designFloorEnds - nowMs;
              setTimeout(drainDeferredBlocks, remaining + 30);
              break;
            }
            // Normal path: paced reveal.
            queueReveal(block);
            break;
          }
          case 'host:update-block': {
            if (!Array.isArray(state.blocks)) break;
            const idx = Number(msg.index);
            if (!Number.isInteger(idx) || idx < 0 || idx >= state.blocks.length) break;
            const current = state.blocks[idx];
            const replace = !!msg.replace;
            const patch = sanitizeBlockProps(msg.props || {});
            const nextProps = replace ? patch : { ...current.props, ...patch };
            state.blocks[idx] = { section: current.section, props: nextProps };
            if (state.mode === 'page') rerender();
            break;
          }
          case 'host:remove-block': {
            if (!Array.isArray(state.blocks)) break;
            const idx = Number(msg.index);
            if (!Number.isInteger(idx) || idx < 0 || idx >= state.blocks.length) break;
            state.blocks.splice(idx, 1);
            // Invalidate seen-keys so indices that shifted after the
            // removal don't reuse stale "already seen" tracking.
            resetReveal();
            if (state.mode === 'page') rerender();
            break;
          }

          default:
            break;
        }
      } catch (err) {
        // Surface bridge handler errors via the error card too.
        window.dispatchEvent(new ErrorEvent('error', {
          error: err,
          message: (err && err.message) || String(err),
          filename: '',
          lineno: 0,
          colno: 0,
        }));
      }
    });

    /* ---------------- First render + handshake ---------------- */

    rerender();
    parent.postMessage({ type: 'host:ready' }, '*');
  </script>
</body>
</html>
`;
