/**
 * Pre-built templates for instant scaffolding.
 *
 * The agent provides brand tokens; we render these templates with simple
 * `{{TOKEN}}` substitution to produce design systems and page shells
 * without round-tripping through the LLM.
 */

export interface BrandTokens {
  name: string;
  primary: string;
  secondary: string;
  accent: string;
  bg: string;
  surface: string;
  fg: string;
  muted: string;
  border: string;
  // Auto-derived at DS-create time — text colors that hit ≥4.5:1 against
  // their respective colored backgrounds. Used by .btn-primary, highlighted
  // PricingCards plans, accent badges, etc. The agent never passes these;
  // they're computed from primary/secondary/accent + fg so that whatever
  // hue the agent picks for the brand color, text on top stays legible.
  onPrimary: string;
  onSecondary: string;
  onAccent: string;
  headingFont: string;
  bodyFont: string;
  radius: string;
}

/**
 * Normalize a font-family value into a CSS-valid `font-family` stack.
 *
 * Agents pass either a single family name (`"Inter"`, `"Press Start 2P"`) or
 * a full stack (`"Impact, 'Arial Black', sans-serif"`). We want both forms
 * to produce valid CSS when interpolated into a `font-family` declaration.
 *
 *   - Stacks (containing a comma) pass through verbatim: the agent is
 *     responsible for proper quoting inside their stack.
 *   - Single names get quoted iff they contain whitespace.
 *   - Already-quoted names pass through.
 */
function normalizeFont(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(",")) return trimmed;
  const isQuoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  if (isQuoted) return trimmed;
  if (/\s/.test(trimmed)) return `'${trimmed.replace(/'/g, "")}'`;
  return trimmed;
}

export function renderTemplate(
  template: string,
  brand: BrandTokens,
  extra: Record<string, string> = {},
): string {
  const vars: Record<string, string> = {
    BRAND_NAME: brand.name,
    BRAND_PRIMARY: brand.primary,
    BRAND_SECONDARY: brand.secondary,
    BRAND_ACCENT: brand.accent,
    BRAND_BG: brand.bg,
    BRAND_SURFACE: brand.surface,
    BRAND_FG: brand.fg,
    BRAND_MUTED: brand.muted,
    BRAND_BORDER: brand.border,
    BRAND_ON_PRIMARY: brand.onPrimary,
    BRAND_ON_SECONDARY: brand.onSecondary,
    BRAND_ON_ACCENT: brand.onAccent,
    BRAND_HEADING_FONT: normalizeFont(brand.headingFont),
    BRAND_BODY_FONT: normalizeFont(brand.bodyFont),
    BRAND_RADIUS: brand.radius,
    ...extra,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value !== undefined ? value : `{{${key}}}`;
  });
}

/* ---------------------------------------------------------------------------
 * Design system: tokens.css
 * ------------------------------------------------------------------------- */

export const DESIGN_SYSTEM_TOKENS_CSS = `:root {
  --brand-primary: {{BRAND_PRIMARY}};
  --brand-secondary: {{BRAND_SECONDARY}};
  --brand-accent: {{BRAND_ACCENT}};
  --brand-bg: {{BRAND_BG}};
  --brand-surface: {{BRAND_SURFACE}};
  --brand-fg: {{BRAND_FG}};
  --brand-muted: {{BRAND_MUTED}};
  --brand-border: {{BRAND_BORDER}};
  /* Auto-derived: text colors guaranteed to hit ≥4.5:1 against their
     respective colored backgrounds. Use these in templates instead of
     hardcoding 'white' on primary backgrounds — primary may be light
     (yellow-green, cream) and 'white' fails contrast then. */
  --brand-on-primary: {{BRAND_ON_PRIMARY}};
  --brand-on-secondary: {{BRAND_ON_SECONDARY}};
  --brand-on-accent: {{BRAND_ON_ACCENT}};
  --brand-radius: {{BRAND_RADIUS}};

  --font-heading: {{BRAND_HEADING_FONT}}, 'Instrument Serif', Georgia, serif;
  --font-body: {{BRAND_BODY_FONT}}, Inter, system-ui, sans-serif;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --space-16: 64px;
  --space-24: 96px;

  --text-xs: 12px;
  --text-sm: 14px;
  --text-base: 16px;
  --text-lg: 18px;
  --text-xl: 22px;
  --text-2xl: 28px;
  --text-3xl: 36px;
  --text-4xl: 48px;
  --text-5xl: 64px;
}

html, body { margin: 0; padding: 0; }
body {
  font-family: var(--font-body);
  background: var(--brand-bg);
  color: var(--brand-fg);
  -webkit-font-smoothing: antialiased;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-6);
  border-radius: var(--brand-radius);
  font-weight: 600;
  font-size: var(--text-base);
  border: 1px solid transparent;
  cursor: pointer;
  transition: transform .08s ease, opacity .15s ease, background .15s ease;
}
.btn:active { transform: translateY(1px); }
.btn-primary { background: var(--brand-primary); color: var(--brand-on-primary); }
.btn-primary:hover { opacity: .9; }
.btn-secondary { background: var(--brand-surface); color: var(--brand-fg); border-color: var(--brand-border); }
.btn-ghost { background: transparent; color: var(--brand-fg); border-color: var(--brand-border); }
.btn-disabled { opacity: .4; cursor: not-allowed; }

.card {
  background: var(--brand-surface);
  border: 1px solid var(--brand-border);
  border-radius: var(--brand-radius);
  padding: var(--space-6);
}

.input, .select, .textarea {
  width: 100%;
  background: var(--brand-bg);
  color: var(--brand-fg);
  border: 1px solid var(--brand-border);
  border-radius: var(--brand-radius);
  padding: var(--space-3) var(--space-4);
  font-family: var(--font-body);
  font-size: var(--text-base);
}
.input:focus, .select:focus, .textarea:focus {
  outline: 2px solid var(--brand-primary);
  outline-offset: 2px;
}

.heading { font-family: var(--font-heading); font-weight: 500; letter-spacing: -0.01em; }

.container {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 var(--space-6);
}

/* ---------------------------------------------------------------------------
 * Reveal animation
 *
 * Every top-level child of <main> (i.e. every section in pages built from
 * the template) and every <section.ds-section> in the design-system demo
 * fades + slides in with a per-child stagger. Re-renders on file change
 * replay the animation, so the preview always feels alive when content
 * appears. Respects \`prefers-reduced-motion\`.
 * ------------------------------------------------------------------------- */

@keyframes deco-reveal {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

main > *,
.ds-section,
.ds-hero {
  animation: deco-reveal 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: 0ms;
}
main > *:nth-child(1) { animation-delay:  40ms; }
main > *:nth-child(2) { animation-delay: 140ms; }
main > *:nth-child(3) { animation-delay: 240ms; }
main > *:nth-child(4) { animation-delay: 340ms; }
main > *:nth-child(5) { animation-delay: 440ms; }
main > *:nth-child(6) { animation-delay: 540ms; }
main > *:nth-child(7) { animation-delay: 640ms; }
main > *:nth-child(8) { animation-delay: 740ms; }
main > *:nth-child(n+9) { animation-delay: 800ms; }

.ds-hero { animation-delay: 60ms; }
.ds-section:nth-of-type(1) { animation-delay: 180ms; }
.ds-section:nth-of-type(2) { animation-delay: 280ms; }
.ds-section:nth-of-type(3) { animation-delay: 380ms; }
.ds-section:nth-of-type(4) { animation-delay: 480ms; }
.ds-section:nth-of-type(5) { animation-delay: 580ms; }
.ds-section:nth-of-type(6) { animation-delay: 680ms; }

@media (prefers-reduced-motion: reduce) {
  main > *, .ds-section, .ds-hero { animation: none; }
}
`;

/* ---------------------------------------------------------------------------
 * Design system: tokens.js is generated programmatically in service.ts
 * via `JSON.stringify(brand)` — emitting JS strings safely with brand
 * values that may contain quotes or commas (font stacks).
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Design system: demo.html
 * ------------------------------------------------------------------------- */

export const DESIGN_SYSTEM_DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{{DESIGN_SYSTEM_NAME}} — Design System</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap" />
  <link rel="stylesheet" href="./tokens.css" />
  <style>
    .ds-section { padding: var(--space-12) 0; border-bottom: 1px solid var(--brand-border); }
    .ds-section:last-child { border-bottom: 0; }
    .ds-eyebrow { font-size: var(--text-xs); letter-spacing: .12em; text-transform: uppercase; color: var(--brand-muted); margin-bottom: var(--space-4); }
    .ds-grid { display: grid; gap: var(--space-4); }
    .ds-grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .ds-grid.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    @media (max-width: 720px) {
      .ds-grid.cols-3, .ds-grid.cols-4 { grid-template-columns: 1fr 1fr; }
    }
    .swatch { display: flex; flex-direction: column; gap: var(--space-2); }
    .swatch-chip { height: 96px; border-radius: var(--brand-radius); border: 1px solid var(--brand-border); }
    .swatch-meta { display: flex; justify-content: space-between; font-size: var(--text-sm); color: var(--brand-muted); }
    .ds-row { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; }
    .ds-stack > * + * { margin-top: var(--space-3); }
    .ds-hero { padding: var(--space-16) 0 var(--space-12); border-bottom: 1px solid var(--brand-border); }
    .ds-hero h1 { font-size: var(--text-5xl); margin: 0 0 var(--space-4); }
    .ds-hero p { color: var(--brand-muted); max-width: 56ch; font-size: var(--text-lg); }
    code { background: var(--brand-surface); border: 1px solid var(--brand-border); padding: 2px 6px; border-radius: 6px; font-size: 12px; color: var(--brand-muted); }
  </style>
</head>
<body>
  <header class="ds-hero">
    <div class="container">
      <p class="ds-eyebrow">Design System</p>
      <h1 class="heading">{{DESIGN_SYSTEM_NAME}}</h1>
      <p>The visual language for pages built on this design system. Edit <code>tokens.css</code> or <code>meta.json</code> to evolve it; every bound page reskins automatically.</p>
    </div>
  </header>

  <main class="container">
    <section class="ds-section">
      <p class="ds-eyebrow">Color</p>
      <div class="ds-grid cols-4" id="ds-colors"></div>
    </section>

    <section class="ds-section">
      <p class="ds-eyebrow">Typography</p>
      <div class="ds-stack">
        <div class="heading" style="font-size: var(--text-5xl); line-height: 1.05;">Display heading set in {{BRAND_HEADING_FONT}}</div>
        <div class="heading" style="font-size: var(--text-3xl);">Section heading</div>
        <div style="font-size: var(--text-xl); color: var(--brand-muted);">Lead paragraph set in {{BRAND_BODY_FONT}}</div>
        <div style="font-size: var(--text-base); max-width: 64ch;">Body copy reads at 16px with comfortable line height. This is the default reading size for paragraphs across pages bound to this design system.</div>
        <div style="font-size: var(--text-sm); color: var(--brand-muted);">Caption / muted text at 14px.</div>
      </div>
    </section>

    <section class="ds-section">
      <p class="ds-eyebrow">Buttons</p>
      <div class="ds-row">
        <button class="btn btn-primary">Primary</button>
        <button class="btn btn-secondary">Secondary</button>
        <button class="btn btn-ghost">Ghost</button>
        <button class="btn btn-primary btn-disabled" disabled>Disabled</button>
      </div>
    </section>

    <section class="ds-section">
      <p class="ds-eyebrow">Cards</p>
      <div class="ds-grid cols-3">
        <div class="card">
          <div class="heading" style="font-size: var(--text-xl); margin-bottom: var(--space-2);">Feature card</div>
          <div style="color: var(--brand-muted); font-size: var(--text-sm);">Short supporting copy that fits within a card.</div>
        </div>
        <div class="card">
          <div class="heading" style="font-size: var(--text-xl); margin-bottom: var(--space-2);">Pricing card</div>
          <div style="font-size: var(--text-4xl); font-weight: 700; margin-bottom: var(--space-2);">$29<span style="font-size: var(--text-base); color: var(--brand-muted); font-weight: 400;">/mo</span></div>
          <button class="btn btn-primary" style="width: 100%;">Start free trial</button>
        </div>
        <div class="card" style="background: var(--brand-primary); color: var(--brand-on-primary); border-color: transparent;">
          <div class="heading" style="font-size: var(--text-xl); margin-bottom: var(--space-2);">Accent card</div>
          <div style="opacity: .85; font-size: var(--text-sm);">Use sparingly to draw attention.</div>
        </div>
      </div>
    </section>

    <section class="ds-section">
      <p class="ds-eyebrow">Form controls</p>
      <div class="ds-grid cols-3">
        <input class="input" placeholder="Text input" />
        <select class="select">
          <option>Select option</option>
          <option>Another option</option>
        </select>
        <textarea class="textarea" rows="3" placeholder="Textarea"></textarea>
      </div>
    </section>

    <section class="ds-section">
      <p class="ds-eyebrow">Spacing</p>
      <div class="ds-row" id="ds-spacing"></div>
    </section>
  </main>

  <script type="module" src="./demo.js"></script>
</body>
</html>
`;

/* ---------------------------------------------------------------------------
 * Design system: demo.js (renders color swatches + spacing scale)
 * ------------------------------------------------------------------------- */

export const DESIGN_SYSTEM_DEMO_JS = `import { BRAND } from './tokens.js';

const colors = [
  ['primary', BRAND.primary],
  ['secondary', BRAND.secondary],
  ['accent', BRAND.accent],
  ['bg', BRAND.bg],
  ['surface', BRAND.surface],
  ['fg', BRAND.fg],
  ['muted', BRAND.muted],
  ['border', BRAND.border],
];

const colorsHost = document.getElementById('ds-colors');
if (colorsHost) {
  colorsHost.innerHTML = colors.map(([name, value]) => \`
    <div class="swatch">
      <div class="swatch-chip" style="background: \${value};"></div>
      <div class="swatch-meta"><span>\${name}</span><code>\${value}</code></div>
    </div>
  \`).join('');
}

const spacings = [4, 8, 12, 16, 24, 32, 48, 64];
const spacingHost = document.getElementById('ds-spacing');
if (spacingHost) {
  spacingHost.innerHTML = spacings.map(n => \`
    <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-start;">
      <div style="height: 12px; width: \${n}px; background: var(--brand-primary); border-radius: 4px;"></div>
      <span style="font-size:12px; color: var(--brand-muted);">\${n}px</span>
    </div>
  \`).join('');
}
`;

/* ---------------------------------------------------------------------------
 * Page template: index.html
 * ------------------------------------------------------------------------- */

export const PAGE_TEMPLATE_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{{PAGE_TITLE}}</title>
  <meta name="description" content="{{PAGE_DESCRIPTION}}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap" />
  <link rel="stylesheet" href="{{TOKENS_CSS_HREF}}" />
  <script type="importmap">
  {
    "imports": {
      "preact": "https://esm.sh/preact@10.25.4",
      "preact/hooks": "https://esm.sh/preact@10.25.4/hooks",
      "htm": "https://esm.sh/htm@3.1.1"
    }
  }
  </script>
  <!--
    Global error handler. Renders a brand-themed error card in the iframe
    when a script error (SyntaxError, ReferenceError, etc.) fires, so the
    user sees what's wrong instead of a silent blank page. A "Fix this"
    button posts the error back to the parent window (Studio's preview
    pane) which composes a chat-input prompt for the agent.
  -->
  <script>
    (function () {
      var BRAND_FALLBACK = { primary: '#A595FF', bg: '#0A0A0F', fg: '#FAFAF9', border: 'rgba(255,255,255,0.15)' };
      function getVar(name, fallback) {
        try {
          var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
          return v || fallback;
        } catch (_e) { return fallback; }
      }
      function escapeHtml(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }
      function relPath(p) {
        try {
          if (!p) return '';
          var u = new URL(p);
          // Strip the /api/<org>/page-preview/files/ prefix so the agent
          // sees a path it recognizes.
          var m = u.pathname.match(/\\/page-preview\\/files\\/(.*)$/);
          return m ? decodeURIComponent(m[1]) : u.pathname + (u.search || '');
        } catch (_e) { return String(p); }
      }
      var rendered = false;
      function render(info) {
        // Only render once — first error wins so we don't flicker between
        // cascading failures.
        if (rendered) return;
        rendered = true;
        var bg = getVar('--brand-bg', BRAND_FALLBACK.bg);
        var fg = getVar('--brand-fg', BRAND_FALLBACK.fg);
        var primary = getVar('--brand-primary', BRAND_FALLBACK.primary);
        var border = getVar('--brand-border', BRAND_FALLBACK.border);
        var card = document.createElement('div');
        card.id = '__page_editor_error_card__';
        card.setAttribute('role', 'alert');
        card.style.cssText = [
          'position:fixed', 'inset:0', 'z-index:2147483647',
          'background:' + bg,
          'color:' + fg,
          'font-family:Inter, system-ui, sans-serif',
          'display:flex', 'align-items:center', 'justify-content:center',
          'padding:32px',
          'animation: pe-fade-in 240ms ease-out both',
        ].join(';');
        card.innerHTML = [
          '<style>',
          '  @keyframes pe-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }',
          '  #__page_editor_error_card__ .pec-card {',
          '    max-width: 640px; width: 100%;',
          '    background: rgba(255,255,255,0.03);',
          '    border: 1px solid ' + border + ';',
          '    border-radius: 16px; padding: 24px 28px;',
          '    box-shadow: 0 18px 60px rgba(0,0,0,0.35);',
          '  }',
          '  #__page_editor_error_card__ .pec-pill {',
          '    display: inline-flex; align-items: center; gap: 8px;',
          '    padding: 4px 10px; border-radius: 999px;',
          '    background: rgba(239, 68, 68, 0.14); color: #fca5a5;',
          '    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;',
          '  }',
          '  #__page_editor_error_card__ h2 {',
          '    margin: 18px 0 8px; font-family: var(--font-heading, inherit); font-weight: 500; font-size: 24px; line-height: 1.25;',
          '  }',
          '  #__page_editor_error_card__ .pec-loc {',
          '    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;',
          '    color: ' + fg + '; opacity: 0.65; margin-bottom: 16px;',
          '  }',
          '  #__page_editor_error_card__ .pec-msg {',
          '    background: rgba(0,0,0,0.25); border: 1px solid ' + border + ';',
          '    border-radius: 10px; padding: 12px 14px;',
          '    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;',
          '    color: ' + fg + '; white-space: pre-wrap; word-break: break-word; line-height: 1.5;',
          '    max-height: 200px; overflow: auto;',
          '  }',
          '  #__page_editor_error_card__ .pec-actions { display: flex; gap: 8px; margin-top: 18px; align-items: center; }',
          '  #__page_editor_error_card__ button.pec-btn {',
          '    appearance: none; cursor: pointer; border: 0;',
          '    background: ' + primary + '; color: #0A0A0F;',
          '    font: 600 13px/1 Inter, system-ui, sans-serif;',
          '    padding: 10px 16px; border-radius: 999px;',
          '    transition: opacity 0.15s ease, transform 0.08s ease;',
          '  }',
          '  #__page_editor_error_card__ button.pec-btn:hover { opacity: 0.92; }',
          '  #__page_editor_error_card__ button.pec-btn:active { transform: translateY(1px); }',
          '  #__page_editor_error_card__ button.pec-btn.pec-ghost {',
          '    background: transparent; color: ' + fg + '; border: 1px solid ' + border + ';',
          '  }',
          '  #__page_editor_error_card__ .pec-hint {',
          '    color: ' + fg + '; opacity: 0.55; font-size: 12px; margin-top: 14px;',
          '  }',
          '</style>',
          '<div class="pec-card">',
          '  <span class="pec-pill">Runtime error</span>',
          '  <h2>' + escapeHtml(info.headline || "Something didn't render") + '</h2>',
          info.location ? '  <div class="pec-loc">' + escapeHtml(info.location) + '</div>' : '',
          '  <div class="pec-msg">' + escapeHtml(info.message) + '</div>',
          '  <div class="pec-actions">',
          '    <button type="button" class="pec-btn" data-action="ask-fix">Ask the agent to fix this</button>',
          '    <button type="button" class="pec-btn pec-ghost" data-action="reload">Reload preview</button>',
          '  </div>',
          '  <div class="pec-hint">The error stays visible until you reload or the agent edits the file.</div>',
          '</div>',
        ].join('');
        document.body.appendChild(card);
        card.querySelector('[data-action="ask-fix"]').addEventListener('click', function () {
          if (!window.parent || window.parent === window) return;
          window.parent.postMessage({
            type: 'page-editor:runtime-error',
            payload: info,
          }, '*');
          // Visual confirmation: dim the button briefly.
          this.style.opacity = '0.55';
          this.textContent = 'Sent to chat ✓';
          var btn = this;
          setTimeout(function () {
            btn.style.opacity = '1';
            btn.textContent = 'Ask the agent to fix this';
          }, 1800);
        });
        card.querySelector('[data-action="reload"]').addEventListener('click', function () {
          location.reload();
        });
      }
      window.addEventListener('error', function (e) {
        var rel = relPath(e.filename || '');
        var loc = rel ? rel + (e.lineno ? ':' + e.lineno : '') + (e.colno ? ':' + e.colno : '') : '';
        var raw = (e.error && (e.error.stack || e.error.message)) || e.message || String(e);
        render({
          headline: (e.error && e.error.name) ? e.error.name + ' in the preview' : 'A script error stopped the page',
          location: loc,
          message: String(raw),
        });
      });
      window.addEventListener('unhandledrejection', function (e) {
        var reason = e.reason;
        var msg = (reason && (reason.stack || reason.message)) || String(reason);
        render({
          headline: 'Unhandled promise rejection',
          location: '',
          message: String(msg),
        });
      });
    })();
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

/* ---------------------------------------------------------------------------
 * Page template: app.js
 * ------------------------------------------------------------------------- */

export const PAGE_TEMPLATE_APP_JS = `import { h, render, Component } from 'preact';
import htm from 'htm';
import { BRAND } from '{{TOKENS_JS_MODULE}}';
import * as Sections from './sections.js';
import { PAGE } from './page.js';

const html = htm.bind(h);

/**
 * Per-section error boundary so a broken section (e.g. inline string event
 * handler that preact rejects) doesn't blank the entire page. The user can
 * still see surrounding sections plus a visible hint about which one failed.
 */
class SectionBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidCatch(err) {
    console.error('[page-editor] section error', this.props.name, err);
  }
  render() {
    if (this.state.err) {
      return html\`
        <div style="padding: 16px 24px; margin: 12px 24px; background: rgba(255,0,0,0.06); color: #b91c1c; border: 1px solid rgba(255,0,0,0.2); border-radius: 8px; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.5;">
          <strong>Section "\${this.props.name}" failed:</strong> \${String(this.state.err && this.state.err.message || this.state.err)}
        </div>
      \`;
    }
    return this.props.children;
  }
}

function EmptyPageState() {
  // Rendered when PAGE = []. Soft "waiting" state in the brand's own
  // palette so the eventual reveal feels intentional, not jarring.
  return html\`
    <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: var(--space-12);">
      <div style="text-align: center; max-width: 32ch;">
        <div style="display:inline-flex; align-items:center; justify-content:center; width: 56px; height: 56px; border-radius: 999px; background: var(--brand-surface); border: 1px solid var(--brand-border); margin-bottom: var(--space-6); animation: deco-pulse 1.4s ease-in-out infinite;">
          <span style="font-size: 22px;">✦</span>
        </div>
        <div class="heading" style="font-size: var(--text-2xl); margin: 0 0 var(--space-3);">Page is ready.</div>
        <p style="color: var(--brand-muted); font-size: var(--text-sm);">Sections will appear here as the agent builds them.</p>
      </div>
      <style>
        @keyframes deco-pulse {
          0%, 100% { transform: scale(1);   opacity: 1;   }
          50%      { transform: scale(1.08); opacity: 0.7; }
        }
      </style>
    </div>
  \`;
}

function App() {
  if (!PAGE || PAGE.length === 0) {
    return html\`<\${EmptyPageState} />\`;
  }
  return html\`
    <main>
      \${PAGE.map((block, i) => {
        const Section = Sections[block.section];
        if (!Section) {
          return html\`<div style="padding:32px; color:#f87171;">Unknown section: \${block.section}</div>\`;
        }
        return html\`
          <\${SectionBoundary} key=\${i} name=\${block.section}>
            <\${Section} brand=\${BRAND} ...\${block.props || {}} />
          </\${SectionBoundary}>
        \`;
      })}
    </main>
  \`;
}

render(html\`<\${App} />\`, document.getElementById('root'));
`;

/* ---------------------------------------------------------------------------
 * Page template: sections.js (nav, hero, features, footer scaffolds)
 * ------------------------------------------------------------------------- */

export const PAGE_TEMPLATE_SECTIONS_JS = `import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

/**
 * Section library. Each export is a pure function of props that renders one
 * section of the page. \`page.js\` lists which sections to render, in order,
 * and supplies their props.
 *
 * Add to this library by exporting new named functions. Compose pages by
 * appending block entries to \`PAGE\` in page.js — one block per Edit.
 */

/**
 * Pick a grid-template-columns string that NEVER leaves orphans.
 *
 * The old approach (\`repeat(auto-fit, minmax(NN, 1fr))\`) was clean in CSS
 * but produced ugly 3+1 layouts on the common case of 4 items at typical
 * preview-pane widths — the 4th item wrapped to a second row by itself,
 * leaving two empty columns of whitespace next to it.
 *
 * Count-based fixed grids are unambiguous:
 *   1 → single column
 *   2 → 2 cols
 *   3 → 3 cols
 *   4 → 2x2 (never 3+1)
 *   5 → 5 cols (rare; agents rarely use 5)
 *   6 → 3x2
 *   else → fall back to auto-fit with the supplied min-width
 *
 * Mobile is handled by .container's responsive width — the grid collapses
 * to fewer columns as the available width drops.
 */
function gridColsFor(n, minPx) {
  if (n <= 1) return '1fr';
  if (n === 2) return 'repeat(2, minmax(0, 1fr))';
  if (n === 3) return 'repeat(3, minmax(0, 1fr))';
  if (n === 4) return 'repeat(2, minmax(0, 1fr))';
  if (n === 6) return 'repeat(3, minmax(0, 1fr))';
  if (n === 5 || n === 7 || n === 8) return 'repeat(' + n + ', minmax(0, 1fr))';
  return 'repeat(auto-fit, minmax(' + (minPx || 220) + 'px, 1fr))';
}

export function Nav(props) {
  const brand = props.brand || {};
  const title = props.title || brand.name || 'Brand';
  const ctaLabel = props.ctaLabel || 'Get started';
  const ctaHref  = props.ctaHref  || '#';
  const items = Array.isArray(props.links) && props.links.length > 0
    ? props.links
    : [
        { label: 'Features', href: '#features' },
        { label: 'Pricing',  href: '#pricing'  },
        { label: 'FAQ',      href: '#faq'      },
      ];
  return html\`
    <nav style="border-bottom: 1px solid var(--brand-border);">
      <div class="container" style="display:flex; align-items:center; justify-content:space-between; padding: var(--space-4) var(--space-6);">
        <div class="heading" style="font-size: var(--text-xl);">\${title}</div>
        <div style="display:flex; gap: var(--space-4); color: var(--brand-muted); font-size: var(--text-sm);">
          \${items.map(it => html\`<a href=\${it.href || '#'} style="color:inherit; text-decoration:none;">\${it.label}</a>\`)}
        </div>
        <a class="btn btn-primary" href=\${ctaHref} style="text-decoration:none;">\${ctaLabel}</a>
      </div>
    </nav>
  \`;
}

/**
 * Hero — page-opening headline + supporting copy + 1-2 CTAs.
 * Tolerates the most common alias the agent reaches for: \`headline\` → title,
 * \`sub\` → subtitle. \`stats\` adds an inline KPI row under the CTAs.
 *
 * props: { eyebrow?, title, subtitle?, ctaPrimary?, ctaPrimaryHref?,
 *          ctaSecondary?, ctaSecondaryHref?, stats?: [{ value, label }] }
 */
export function Hero(props) {
  const eyebrow = props.eyebrow;
  const title = props.title || props.headline || 'Build a beautiful page.';
  const subtitle = props.subtitle || props.sub;
  const ctaPrimary = props.ctaPrimary;
  const ctaPrimaryHref = props.ctaPrimaryHref || '#';
  const ctaSecondary = props.ctaSecondary;
  const ctaSecondaryHref = props.ctaSecondaryHref || '#';
  const stats = Array.isArray(props.stats) ? props.stats : [];
  return html\`
    <section style="padding: var(--space-24) 0;">
      <div class="container" style="text-align:center;">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-4);">\${eyebrow}</p>\`}
        <h1 class="heading" style="font-size: var(--text-5xl); line-height: 1.05; margin: 0 0 var(--space-6); max-width: 22ch; margin-left: auto; margin-right: auto;">\${title}</h1>
        \${subtitle && html\`<p class="lede" style="font-size: var(--text-lg); color: var(--brand-muted); max-width: 56ch; margin: 0 auto var(--space-8);">\${subtitle}</p>\`}
        \${(ctaPrimary || ctaSecondary) && html\`
          <div style="display:flex; gap: var(--space-3); justify-content:center;">
            \${ctaPrimary  && html\`<a class="btn btn-primary" href=\${ctaPrimaryHref} style="text-decoration:none;">\${ctaPrimary}</a>\`}
            \${ctaSecondary && html\`<a class="btn btn-ghost" href=\${ctaSecondaryHref} style="text-decoration:none;">\${ctaSecondary}</a>\`}
          </div>
        \`}
        \${stats.length > 0 && html\`
          <dl style=\${'display:grid; grid-template-columns: ' + gridColsFor(stats.length, 140) + '; gap: var(--space-8); margin: var(--space-12) auto 0; max-width: 720px;'}>
            \${stats.map(s => html\`<div class="stat">
              <dt class="heading" style="font-size: var(--text-3xl); font-weight: 700; margin: 0 0 4px;">\${s.value || s.number || '—'}</dt>
              <dd style="color: var(--brand-muted); font-size: var(--text-sm); line-height: 1.4; margin: 0;">\${s.label || ''}</dd>
            </div>\`)}
          </dl>
        \`}
      </div>
    </section>
  \`;
}

/**
 * A 3-column (or auto-fit) grid of feature cards.
 * props: { eyebrow?, title?, intro?, items: [{ icon?, title, body }] }
 */
export function FeatureGrid({ eyebrow, title, intro, items }) {
  const features = Array.isArray(items) ? items : [];
  return html\`
    <section id="features" style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-4); max-width: 24ch;">\${title}</h2>\`}
        \${intro && html\`<p style="color: var(--brand-muted); max-width: 60ch; margin: 0 0 var(--space-12); font-size: var(--text-lg);">\${intro}</p>\`}
        <div style=\${'display:grid; grid-template-columns: ' + gridColsFor(features.length, 260) + '; gap: var(--space-6);'}>
          \${features.map(f => html\`
            <div class="card">
              \${f.icon && html\`<div style="font-size: 28px; margin-bottom: var(--space-4);">\${f.icon}</div>\`}
              <div class="heading" style="font-size: var(--text-xl); margin: 0 0 var(--space-2);">\${f.title}</div>
              \${f.body && html\`<div style="color: var(--brand-muted); font-size: var(--text-sm); line-height: 1.55;">\${f.body}</div>\`}
            </div>
          \`)}
        </div>
      </div>
    </section>
  \`;
}

/**
 * Pricing cards row, optionally with one highlighted plan + "Most popular"
 * badge. Tolerates \`cards\` / \`items\` as aliases for \`plans\` because the
 * agent occasionally reaches for those vocabulary variants.
 *
 * props: { eyebrow?, title?, intro?, plans: [{ name, price, period?,
 *           description?, badge?, features: string[], cta?, highlight?: boolean }] }
 */
export function PricingCards(props) {
  const eyebrow = props.eyebrow;
  const title = props.title;
  const intro = props.intro;
  const raw = props.plans || props.cards || props.items;
  const tiers = Array.isArray(raw) ? raw : [];
  return html\`
    <section id="pricing" style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-4); max-width: 22ch;">\${title}</h2>\`}
        \${intro && html\`<p style="color: var(--brand-muted); max-width: 60ch; margin: 0 0 var(--space-12); font-size: var(--text-lg);">\${intro}</p>\`}
        <div style=\${'display:grid; grid-template-columns: ' + gridColsFor(tiers.length, 260) + '; gap: var(--space-4);'}>
          \${tiers.map(p => html\`
            <div class="card" style=\${p.highlight
              ? 'background: var(--brand-primary); color: var(--brand-on-primary); border-color: transparent; position: relative; padding-top: ' + (p.badge ? '36px' : 'var(--space-6)') + ';'
              : 'position: relative; padding-top: ' + (p.badge ? '36px' : 'var(--space-6)') + ';'}>
              \${p.badge && html\`<div style=\${'position:absolute; top:12px; left:12px; padding: 4px 10px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; background: ' + (p.highlight ? 'var(--brand-bg)' : 'var(--brand-primary)') + '; color: ' + (p.highlight ? 'var(--brand-fg)' : 'var(--brand-on-primary)') + '; border: 1px solid ' + (p.highlight ? 'var(--brand-bg)' : 'transparent') + ';'}>\${p.badge}</div>\`}
              <div class="heading" style="font-size: var(--text-lg); margin: 0 0 var(--space-2);">\${p.name}</div>
              \${p.description && html\`<div style="\${p.highlight ? 'color: color-mix(in srgb, var(--brand-on-primary) 85%, transparent);' : 'color: var(--brand-muted);'} font-size: var(--text-sm); margin: 0 0 var(--space-4); line-height: 1.45;">\${p.description}</div>\`}
              <div style="display:flex; align-items:baseline; gap:6px; margin: 0 0 var(--space-4);">
                <span style="font-size: var(--text-4xl); font-weight: 700;">\${p.price}</span>
                \${p.period && html\`<span style="color: \${p.highlight ? 'color-mix(in srgb, var(--brand-on-primary) 75%, transparent)' : 'var(--brand-muted)'}; font-size: var(--text-sm);">/\${p.period}</span>\`}
              </div>
              \${Array.isArray(p.features) && p.features.length > 0 && html\`
                <ul style="list-style:none; padding:0; margin: 0 0 var(--space-6); display:flex; flex-direction:column; gap: 8px; font-size: var(--text-sm);">
                  \${p.features.map(f => html\`<li style="display:flex; gap:8px; align-items:flex-start;"><span aria-hidden="true">✓</span><span style="\${p.highlight ? '' : 'color: var(--brand-fg);'}">\${f}</span></li>\`)}
                </ul>
              \`}
              \${p.highlight
                ? html\`<button style="width:100%; padding: 12px 18px; border-radius: var(--brand-radius); background: var(--brand-bg); color: var(--brand-fg); border: 0; font-weight: 600; font-size: var(--text-base); font-family: inherit; cursor: pointer;">\${p.cta || 'Get started'}</button>\`
                : html\`<button class="btn btn-primary" style="width: 100%;">\${p.cta || 'Get started'}</button>\`}
            </div>
          \`)}
        </div>
      </div>
    </section>
  \`;
}

/**
 * A single large pull-quote with attribution.
 * props: { quote, author, role? }
 */
export function TestimonialQuote({ quote, author, role }) {
  return html\`
    <section style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container" style="max-width: 800px; text-align:center;">
        <p class="heading" style="font-size: var(--text-3xl); line-height: 1.25; margin: 0 0 var(--space-6);">“\${quote}”</p>
        <div style="color: var(--brand-muted); font-size: var(--text-sm);">— \${author}\${role ? html\`, \${role}\` : null}</div>
      </div>
    </section>
  \`;
}

/**
 * Logo strip / social proof.
 * props: { eyebrow?, items: string[] }   // items can be text labels or image URLs
 */
export function LogoStrip({ eyebrow, items }) {
  const logos = Array.isArray(items) ? items : [];
  return html\`
    <section style="padding: var(--space-12) 0; border-top: 1px solid var(--brand-border);">
      <div class="container">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); text-align:center; margin: 0 0 var(--space-6);">\${eyebrow}</p>\`}
        <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap: var(--space-12); opacity: .85;">
          \${logos.map(it => /^https?:\\/\\//.test(String(it))
            ? html\`<img src=\${it} alt="" style="height: 24px; opacity: .9;" />\`
            : html\`<span style="font-family: var(--font-heading); font-size: var(--text-xl); color: var(--brand-fg); letter-spacing: .04em;">\${it}</span>\`)}
        </div>
      </div>
    </section>
  \`;
}

/**
 * FAQ list — accordion-free for simplicity.
 * Items accept either \`{ question, answer }\` (the agent's most common
 * shape, 28× in usage) or the short \`{ q, a }\` form.
 *
 * props: { eyebrow?, title?, items: [{ question | q, answer | a }] }
 */
export function FAQ({ eyebrow, title, items }) {
  const list = Array.isArray(items) ? items : [];
  return html\`
    <section id="faq" style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container" style="max-width: 800px;">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-12); max-width: 24ch;">\${title}</h2>\`}
        <div style="display:flex; flex-direction:column; gap: var(--space-6);">
          \${list.map(item => {
            const q = item.question || item.q || '';
            const a = item.answer || item.a || '';
            return html\`
              <div class="faq-item">
                <h3 class="heading" style="font-size: var(--text-xl); margin: 0 0 var(--space-2);">\${q}</h3>
                \${a && html\`<p class="faq-answer" style="color: var(--brand-muted); font-size: var(--text-base); line-height: 1.55; margin: 0;">\${a}</p>\`}
              </div>
            \`;
          })}
        </div>
      </div>
    </section>
  \`;
}

/**
 * Email-capture form for waitlists / newsletters.
 * props: { eyebrow?, title?, body?, cta?, placeholder? }
 */
export function EmailCapture({ eyebrow, title, body, cta, placeholder }) {
  return html\`
    <section style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container" style="max-width: 640px; text-align:center;">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-4);">\${title}</h2>\`}
        \${body && html\`<p style="color: var(--brand-muted); margin: 0 0 var(--space-6);">\${body}</p>\`}
        <form style="display:flex; gap: var(--space-2);" onSubmit=\${(e) => e.preventDefault()}>
          <input class="input" type="email" placeholder=\${placeholder || 'you@example.com'} style="flex: 1;" />
          <button class="btn btn-primary" type="submit">\${cta || 'Notify me'}</button>
        </form>
      </div>
    </section>
  \`;
}

/**
 * Final CTA strip.
 * Body accepts \`subtitle\` as an alias (8 pages reached for that name).
 * CTAs accept hrefs for actual navigation. \`note\` renders smaller grey
 * text below the buttons (e.g. "No credit card required").
 *
 * props: { eyebrow?, title, body? | subtitle?, ctaPrimary?, ctaPrimaryHref?,
 *          ctaSecondary?, ctaSecondaryHref?, note? }
 */
export function CTASection(props) {
  const eyebrow = props.eyebrow;
  const title = props.title || 'Ready to ship?';
  const body = props.body || props.subtitle;
  const ctaPrimary = props.ctaPrimary;
  const ctaPrimaryHref = props.ctaPrimaryHref || '#';
  const ctaSecondary = props.ctaSecondary;
  const ctaSecondaryHref = props.ctaSecondaryHref || '#';
  const note = props.note || props.footnote;
  return html\`
    <section style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container" style="text-align:center;">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        <h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-4); max-width: 22ch; margin-left: auto; margin-right: auto;">\${title}</h2>
        \${body && html\`<p style="color: var(--brand-muted); max-width: 56ch; margin: 0 auto var(--space-8);">\${body}</p>\`}
        \${(ctaPrimary || ctaSecondary) && html\`
          <div style="display:flex; gap: var(--space-3); justify-content:center;">
            \${ctaPrimary  && html\`<a class="btn btn-primary" href=\${ctaPrimaryHref} style="text-decoration:none;">\${ctaPrimary}</a>\`}
            \${ctaSecondary && html\`<a class="btn btn-ghost" href=\${ctaSecondaryHref} style="text-decoration:none;">\${ctaSecondary}</a>\`}
          </div>
        \`}
        \${note && html\`<p style="color: var(--brand-muted); font-size: var(--text-sm); margin: var(--space-4) 0 0;">\${note}</p>\`}
      </div>
    </section>
  \`;
}

/**
 * Numbered or icon-led "how it works" sequence (vertical or grid layout).
 * Each step can supply \`number\` ("01"), \`icon\` (emoji), or both. Body is
 * one or two short sentences — keep it tight.
 *
 * props: { id?, eyebrow?, title?, intro?,
 *          steps: [{ number?, icon?, title, body? }] }
 */
export function Steps({ id, eyebrow, title, intro, steps }) {
  const list = Array.isArray(steps) ? steps : [];
  return html\`
    <section id=\${id || 'how-it-works'} style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-4); max-width: 24ch;">\${title}</h2>\`}
        \${intro && html\`<p style="color: var(--brand-muted); max-width: 60ch; margin: 0 0 var(--space-12); font-size: var(--text-lg);">\${intro}</p>\`}
        <div style=\${'display: grid; grid-template-columns: ' + gridColsFor(list.length, 260) + '; gap: var(--space-6);'}>
          \${list.map((s, i) => html\`
            <div style="display:flex; flex-direction:column; gap: var(--space-3);">
              <div style="display:flex; align-items:center; gap: var(--space-3);">
                \${s.icon
                  ? html\`<div style="font-size: 28px;">\${s.icon}</div>\`
                  : html\`<div class="heading" style="font-size: var(--text-3xl); color: var(--brand-primary); line-height: 1; font-weight: 700; min-width: 2ch;">\${s.number || String(i + 1).padStart(2, '0')}</div>\`}
                <div class="heading" style="font-size: var(--text-xl);">\${s.title}</div>
              </div>
              \${s.body && html\`<div style="color: var(--brand-muted); font-size: var(--text-base); line-height: 1.55;">\${s.body}</div>\`}
            </div>
          \`)}
        </div>
      </div>
    </section>
  \`;
}

/**
 * Number-strip / KPI band — typically used after the Hero or to anchor
 * a section break with social-proof metrics.
 *
 * props: { eyebrow?, title?, items: [{ value, label }] }
 *   - \`value\` may also be passed as \`number\` (alias).
 */
export function StatStrip({ eyebrow, title, items }) {
  const list = Array.isArray(items) ? items : [];
  return html\`
    <section style="padding: var(--space-16) 0; border-top: 1px solid var(--brand-border);">
      <div class="container">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3); text-align:center;">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-3xl); margin: 0 0 var(--space-8); max-width: 24ch; text-align:center; margin-left:auto; margin-right:auto;">\${title}</h2>\`}
        <dl style=\${'display:grid; grid-template-columns: ' + gridColsFor(list.length, 140) + '; gap: var(--space-8); text-align:center; margin: 0;'}>
          \${list.map(s => html\`
            <div class="stat">
              <dt class="heading" style="font-size: var(--text-5xl); font-weight: 700; line-height: 1; margin: 0 0 var(--space-2); color: var(--brand-primary);">\${s.value || s.number || '—'}</dt>
              <dd style="color: var(--brand-muted); font-size: var(--text-sm); line-height: 1.4; margin: 0;">\${s.label || ''}</dd>
            </div>
          \`)}
        </dl>
      </div>
    </section>
  \`;
}

/**
 * 2–3 column quote grid with optional metric/company/rating per card.
 * Use this for richer social-proof sections than the single-pull-quote
 * \`TestimonialQuote\`.
 *
 * props: { eyebrow?, title?, items: [{ quote, author, role?, company?,
 *           metric?, rating? }] }
 */
export function TestimonialGrid({ eyebrow, title, items }) {
  const list = Array.isArray(items) ? items : [];
  return html\`
    <section style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-12); max-width: 24ch;">\${title}</h2>\`}
        <div style=\${'display:grid; grid-template-columns: ' + gridColsFor(list.length, 280) + '; gap: var(--space-4);'}>
          \${list.map(t => html\`
            <div class="card" style="display:flex; flex-direction:column; gap: var(--space-4);">
              \${t.rating && html\`<div style="color: var(--brand-primary); font-size: var(--text-sm); letter-spacing: 2px;">\${'★'.repeat(Math.max(0, Math.min(5, t.rating)))}</div>\`}
              <p style="font-size: var(--text-base); line-height: 1.5; margin: 0;">"\${t.quote}"</p>
              \${t.metric && html\`<div class="heading" style="font-size: var(--text-lg); color: var(--brand-primary);">\${t.metric}</div>\`}
              <div style="display:flex; flex-direction:column; gap: 2px; margin-top: auto;">
                <div style="font-weight: 600; font-size: var(--text-sm);">\${t.author}</div>
                \${(t.role || t.company) && html\`<div style="color: var(--brand-muted); font-size: var(--text-sm);">\${[t.role, t.company].filter(Boolean).join(' · ')}</div>\`}
              </div>
            </div>
          \`)}
        </div>
      </div>
    </section>
  \`;
}

/**
 * Two-side "before / after" block. Left column lists the problem state
 * (typically what life is like today, in bullet form); right column lists
 * the solution state with the same number of bullets.
 *
 * props: { eyebrow?, title?,
 *          problem: { title, bullets: string[] },
 *          solution: { title, bullets: string[] } }
 */
export function ProblemSolution({ eyebrow, title, problem, solution }) {
  const p = problem || { title: '', bullets: [] };
  const s = solution || { title: '', bullets: [] };
  const pb = Array.isArray(p.bullets) ? p.bullets : [];
  const sb = Array.isArray(s.bullets) ? s.bullets : [];
  return html\`
    <section style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-12); max-width: 28ch;">\${title}</h2>\`}
        <div style=\${'display:grid; grid-template-columns: ' + gridColsFor(2, 280) + '; gap: var(--space-4);'}>
          <div class="card">
            <div class="heading" style="font-size: var(--text-xl); margin: 0 0 var(--space-4); color: var(--brand-muted);">\${p.title || 'Before'}</div>
            <ul style="list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap: var(--space-3);">
              \${pb.map(b => html\`<li style="display:flex; gap:8px; align-items:flex-start; color: var(--brand-muted); font-size: var(--text-base); line-height: 1.5;"><span aria-hidden="true">✕</span><span>\${b}</span></li>\`)}
            </ul>
          </div>
          <div class="card" style="background: var(--brand-primary); color: var(--brand-on-primary); border-color: transparent;">
            <div class="heading" style="font-size: var(--text-xl); margin: 0 0 var(--space-4);">\${s.title || 'After'}</div>
            <ul style="list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap: var(--space-3);">
              \${sb.map(b => html\`<li style="display:flex; gap:8px; align-items:flex-start; font-size: var(--text-base); line-height: 1.5;"><span aria-hidden="true">✓</span><span>\${b}</span></li>\`)}
            </ul>
          </div>
        </div>
      </div>
    </section>
  \`;
}

export function Footer({ brand }) {
  return html\`
    <footer style="padding: var(--space-12) 0; border-top: 1px solid var(--brand-border); margin-top: var(--space-16);">
      <div class="container" style="display:flex; justify-content:space-between; color: var(--brand-muted); font-size: var(--text-sm);">
        <span>© \${new Date().getFullYear()} \${brand?.name || 'Brand'}</span>
        <span>Built with Page Editor</span>
      </div>
    </footer>
  \`;
}

/* ---------------------------------------------------------------------------
 * Beyond-landing sections
 *
 * The 10 sections below extend the library past pure conversion funnels
 * into territory we want it to cover too — internal memos, OKR / status
 * docs, strategy briefs, lightweight data viz, blog posts.
 * ------------------------------------------------------------------------- */

/**
 * MetricsGrid — KPI / OKR cards. Each card carries a label, current
 * value, optional target, and an auto-computed progress bar.
 *
 * props: { eyebrow?, title?, intro?, items: [{ label, current, target?,
 *   unit?, note? }] }
 */
export function MetricsGrid({ eyebrow, title, intro, items }) {
  const list = Array.isArray(items) ? items : [];
  return html\`
    <section style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-4); max-width: 24ch;">\${title}</h2>\`}
        \${intro && html\`<p style="color: var(--brand-muted); max-width: 60ch; margin: 0 0 var(--space-8); font-size: var(--text-lg);">\${intro}</p>\`}
        <div style=\${'display:grid; grid-template-columns: ' + gridColsFor(list.length, 260) + '; gap: var(--space-4);'}>
          \${list.map(m => {
            const current = Number(m.current);
            const target = Number(m.target);
            const hasTarget = Number.isFinite(target) && target > 0;
            const pct = hasTarget && Number.isFinite(current)
              ? Math.max(0, Math.min(100, Math.round((current / target) * 100)))
              : null;
            return html\`
              <div class="card">
                <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom: var(--space-2);">
                  <span style="color: var(--brand-muted); font-size: var(--text-sm); letter-spacing:.04em; text-transform:uppercase;">\${m.label || 'Metric'}</span>
                  \${pct !== null && html\`<span style="font-size: var(--text-xs); color: var(--brand-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">\${pct}%</span>\`}
                </div>
                <div style="display:flex; align-items:baseline; gap: 6px; margin-bottom: var(--space-3);">
                  <span class="heading" style="font-size: var(--text-4xl); font-weight: 700; line-height: 1;">\${m.current == null ? '—' : m.current}</span>
                  \${hasTarget && html\`<span style="color: var(--brand-muted); font-size: var(--text-sm);">/ \${m.target}\${m.unit ? ' ' + m.unit : ''}</span>\`}
                </div>
                \${pct !== null && html\`<div style="height: 6px; background: var(--brand-border); border-radius: 999px; overflow: hidden;">
                  <div style=\${'height:100%; width:' + pct + '%; background: var(--brand-primary); transition: width 480ms cubic-bezier(0.22,1,0.36,1);'}></div>
                </div>\`}
                \${m.note && html\`<p style="color: var(--brand-muted); font-size: var(--text-sm); margin: var(--space-2) 0 0; line-height:1.45;">\${m.note}</p>\`}
              </div>
            \`;
          })}
        </div>
      </div>
    </section>
  \`;
}

/**
 * Timeline — vertical milestone list with date + title + body per item.
 * Use for roadmaps, OKR delivery dates, changelog summaries.
 *
 * props: { eyebrow?, title?, intro?, items: [{ date?, title, body? }] }
 */
export function Timeline({ eyebrow, title, intro, items }) {
  const list = Array.isArray(items) ? items : [];
  return html\`
    <section style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container" style="max-width: 860px;">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-4); max-width: 24ch;">\${title}</h2>\`}
        \${intro && html\`<p style="color: var(--brand-muted); max-width: 60ch; margin: 0 0 var(--space-12); font-size: var(--text-lg);">\${intro}</p>\`}
        <ol style="list-style: none; padding: 0; margin: 0;">
          \${list.map(it => html\`
            <li style="position: relative; padding: 0 0 var(--space-8) var(--space-8); border-left: 2px solid var(--brand-border);">
              <div style="position: absolute; left: -7px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: var(--brand-primary); border: 3px solid var(--brand-bg);"></div>
              <div style="display:flex; justify-content:space-between; gap: var(--space-3); align-items:baseline; flex-wrap:wrap;">
                <div class="heading" style="font-size: var(--text-xl); margin: 0;">\${it.title || 'Milestone'}</div>
                \${it.date && html\`<div style="color: var(--brand-muted); font-size: var(--text-sm); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:.02em;">\${it.date}</div>\`}
              </div>
              \${it.body && html\`<p style="color: var(--brand-muted); margin: var(--space-2) 0 0; max-width: 64ch; line-height:1.55;">\${it.body}</p>\`}
            </li>
          \`)}
        </ol>
      </div>
    </section>
  \`;
}

/**
 * Chart — minimal horizontal bar chart. Pure CSS, no chart library.
 * Each datum: { label, value, max?, unit?, color? }. If \`max\` is set
 * on any datum we use the highest \`max\`; otherwise we normalize to
 * the largest value.
 *
 * props: { eyebrow?, title?, intro?, data: [{ label, value, ... }] }
 */
export function Chart({ eyebrow, title, intro, data }) {
  const list = Array.isArray(data) ? data : [];
  const explicitMax = list.reduce((m, d) => Math.max(m, Number(d.max) || 0), 0);
  const dataMax = list.reduce((m, d) => Math.max(m, Number(d.value) || 0), 0);
  const max = explicitMax > 0 ? explicitMax : (dataMax || 1);
  return html\`
    <section style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container" style="max-width: 880px;">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-3xl); margin: 0 0 var(--space-4); max-width: 28ch;">\${title}</h2>\`}
        \${intro && html\`<p style="color: var(--brand-muted); max-width: 60ch; margin: 0 0 var(--space-8); font-size: var(--text-base);">\${intro}</p>\`}
        <div role="img" aria-label=\${title || 'Chart'} style="display:flex; flex-direction:column; gap: var(--space-3);">
          \${list.map(d => {
            const val = Number(d.value) || 0;
            const pct = max > 0 ? Math.max(0, Math.min(100, (val / max) * 100)) : 0;
            const fill = d.color || 'var(--brand-primary)';
            return html\`
              <div>
                <div style="display:flex; justify-content:space-between; gap: var(--space-3); font-size: var(--text-sm); margin-bottom: 4px;">
                  <span>\${d.label || ''}</span>
                  <span style="color: var(--brand-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">\${d.value == null ? '' : d.value}\${d.unit ? ' ' + d.unit : ''}</span>
                </div>
                <div style="height: 12px; background: var(--brand-border); border-radius: 999px; overflow: hidden;">
                  <div style=\${'height:100%; width:' + pct + '%; background:' + fill + '; transition: width 480ms cubic-bezier(0.22,1,0.36,1);'}></div>
                </div>
              </div>
            \`;
          })}
        </div>
      </div>
    </section>
  \`;
}

/**
 * Callout — boxed note with a variant flag for decision logs, risks,
 * TL;DRs, or info asides. Variant defaults to "info".
 *
 * props: { variant?: 'info'|'tldr'|'warn'|'success'|'risk', title?, body, icon? }
 */
export function Callout({ variant, title, body, icon }) {
  const palette = {
    info:    { accent: 'var(--brand-primary)', wash: '8%' },
    tldr:    { accent: 'var(--brand-fg)',      wash: '6%' },
    warn:    { accent: '#f59e0b',              wash: '12%' },
    success: { accent: '#10b981',              wash: '12%' },
    risk:    { accent: '#ef4444',              wash: '12%' },
  };
  const v = palette[variant] || palette.info;
  const label = (variant || 'note').toUpperCase();
  const bg = 'color-mix(in srgb, ' + v.accent + ' ' + v.wash + ', transparent)';
  return html\`
    <section style="padding: var(--space-8) 0;">
      <div class="container" style="max-width: 760px;">
        <aside role="note" style=\${'background:' + bg + '; border-left: 4px solid ' + v.accent + '; padding: var(--space-4) var(--space-6); border-radius: 8px;'}>
          <div style="display:flex; gap: var(--space-4); align-items:flex-start;">
            <div style=\${'font-size: var(--text-xs); font-weight: 700; letter-spacing: .12em; color:' + v.accent + '; min-width: 64px; flex-shrink:0; padding-top: 2px;'}>\${icon ? icon + ' ' : ''}\${label}</div>
            <div style="flex:1; min-width:0;">
              \${title && html\`<div class="heading" style="font-size: var(--text-xl); margin: 0 0 var(--space-2);">\${title}</div>\`}
              \${body && html\`<p style="margin: 0; line-height:1.55;">\${body}</p>\`}
            </div>
          </div>
        </aside>
      </div>
    </section>
  \`;
}

/**
 * KeyTakeaways — TL;DR bullet list for the top of a long-form page.
 * Designed to be skimmed in 5 seconds before the reader commits.
 *
 * props: { eyebrow?, title?, items: string[] }
 */
export function KeyTakeaways({ eyebrow, title, items }) {
  const list = Array.isArray(items) ? items : [];
  return html\`
    <section style="padding: var(--space-12) 0;">
      <div class="container" style="max-width: 800px;">
        <div style="background: var(--brand-surface); border: 1px solid var(--brand-border); border-radius: var(--brand-radius); padding: var(--space-6) var(--space-8);">
          \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-2);">\${eyebrow}</p>\`}
          \${title && html\`<h2 class="heading" style="font-size: var(--text-2xl); margin: 0 0 var(--space-4);">\${title || 'Key takeaways'}</h2>\`}
          <ul style="list-style: none; padding: 0; margin: 0; display:flex; flex-direction:column; gap: var(--space-3);">
            \${list.map(it => html\`
              <li style="display:flex; gap: var(--space-3); align-items:flex-start;">
                <span style="color: var(--brand-primary); font-weight: 700; flex-shrink:0; line-height: 1.55;">→</span>
                <span style="line-height:1.55;">\${it}</span>
              </li>
            \`)}
          </ul>
        </div>
      </div>
    </section>
  \`;
}

/**
 * LongFormBody — multi-paragraph article-style prose section. Use for
 * memos, strategy docs, blog posts. Each paragraph is one string;
 * blank line in source maps to one paragraph in render.
 *
 * props: { eyebrow?, title?, paragraphs: string[] }
 */
export function LongFormBody({ eyebrow, title, paragraphs }) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  return html\`
    <section style="padding: var(--space-16) 0;">
      <div class="container" style="max-width: 720px;">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-3xl); margin: 0 0 var(--space-6); line-height: 1.15; max-width: 28ch;">\${title}</h2>\`}
        <article style="font-size: var(--text-lg); line-height: 1.7;">
          \${list.map(p => html\`<p style="margin: 0 0 var(--space-4); max-width: 64ch;">\${p}</p>\`)}
        </article>
      </div>
    </section>
  \`;
}

/**
 * Byline — author + role + date + tags strip for memos and blog posts.
 *
 * props: { author, role?, date?, tags?: string[] }
 */
export function Byline({ author, role, date, tags }) {
  const list = Array.isArray(tags) ? tags : [];
  return html\`
    <section style="padding: var(--space-6) 0;">
      <div class="container" style="max-width: 720px;">
        <div style="display:flex; gap: var(--space-4); align-items:center; flex-wrap:wrap; font-size: var(--text-sm); color: var(--brand-muted);">
          \${author && html\`<div style="display:flex; align-items:center; gap: var(--space-2);">
            <div style="width: 28px; height: 28px; border-radius: 50%; background: var(--brand-primary); color: var(--brand-on-primary, white); display:flex; align-items:center; justify-content:center; font-size: 12px; font-weight: 700;">\${String(author).slice(0,1).toUpperCase()}</div>
            <span style="color: var(--brand-fg);"><strong>\${author}</strong>\${role ? ' · ' + role : ''}</span>
          </div>\`}
          \${date && html\`<time style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;">\${date}</time>\`}
          \${list.length > 0 && html\`<div style="display:flex; gap: 6px; flex-wrap:wrap;">
            \${list.map(t => html\`<span style="font-size: 11px; padding: 2px 8px; border: 1px solid var(--brand-border); border-radius: 999px; letter-spacing:.04em;">\${t}</span>\`)}
          </div>\`}
        </div>
      </div>
    </section>
  \`;
}

/**
 * Comparison — feature matrix table. Each row is one feature; each
 * column is one option / plan / vendor. Values can be strings ("Yes",
 * "Free", "50/mo") or booleans (true → ✓, false → —).
 *
 * props: { eyebrow?, title?, intro?, columns: string[],
 *   rows: [{ label, values: (string|boolean)[], emphasize?: boolean }],
 *   highlightColumn?: number }
 */
export function Comparison({ eyebrow, title, intro, columns, rows, highlightColumn }) {
  const cols = Array.isArray(columns) ? columns : [];
  const list = Array.isArray(rows) ? rows : [];
  const hi = typeof highlightColumn === 'number' ? highlightColumn : -1;
  const cellOf = (v) => v === true ? '✓' : v === false ? '—' : (v == null ? '' : String(v));
  return html\`
    <section style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-4); max-width: 28ch;">\${title}</h2>\`}
        \${intro && html\`<p style="color: var(--brand-muted); max-width: 60ch; margin: 0 0 var(--space-8); font-size: var(--text-lg);">\${intro}</p>\`}
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse; min-width: 480px;">
            <thead>
              <tr>
                <th style="text-align:left; padding: var(--space-3); border-bottom: 2px solid var(--brand-border); font-weight: 600; font-size: var(--text-sm); color: var(--brand-muted);"></th>
                \${cols.map((c, i) => html\`<th style=\${'text-align:left; padding: var(--space-3); border-bottom: 2px solid ' + (i === hi ? 'var(--brand-primary)' : 'var(--brand-border)') + '; font-weight:' + (i === hi ? '700' : '600') + '; font-size: var(--text-base); color:' + (i === hi ? 'var(--brand-primary)' : 'var(--brand-fg)') + ';'}>\${c}</th>\`)}
              </tr>
            </thead>
            <tbody>
              \${list.map(r => {
                const vals = Array.isArray(r.values) ? r.values : [];
                return html\`<tr>
                  <td style=\${'padding: var(--space-3); border-bottom: 1px solid var(--brand-border); font-weight:' + (r.emphasize ? '600' : '400') + '; color: var(--brand-fg); font-size: var(--text-sm);'}>\${r.label || ''}</td>
                  \${vals.map((v, i) => html\`<td style=\${'padding: var(--space-3); border-bottom: 1px solid var(--brand-border); font-size: var(--text-sm); color:' + (i === hi ? 'var(--brand-fg)' : 'var(--brand-muted)') + '; background:' + (i === hi ? 'color-mix(in srgb, var(--brand-primary) 4%, transparent)' : 'transparent') + ';'}>\${cellOf(v)}</td>\`)}
                </tr>\`;
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  \`;
}

/**
 * BeforeAfter — split-panel transformation. Different from
 * ProblemSolution: this is about state change (where you were → where
 * you'll be), not pain → fix. Two side-by-side cards.
 *
 * props: { eyebrow?, title?, before: { title?, body?, bullets?: string[] },
 *   after: { title?, body?, bullets?: string[] } }
 */
export function BeforeAfter({ eyebrow, title, before, after }) {
  const b = before || {};
  const a = after || {};
  const panel = (data, isAfter) => html\`
    <div class="card" style=\${isAfter ? 'background: var(--brand-primary); color: var(--brand-on-primary, white); border-color: transparent;' : ''}>
      <p style=\${'font-size: var(--text-xs); letter-spacing:.14em; text-transform:uppercase; margin: 0 0 var(--space-3); opacity:' + (isAfter ? '0.75' : '0.6') + ';'}>\${isAfter ? 'After' : 'Before'}</p>
      <div class="heading" style="font-size: var(--text-2xl); margin: 0 0 var(--space-3);">\${data.title || (isAfter ? 'With us' : 'Today')}</div>
      \${data.body && html\`<p style=\${'font-size: var(--text-base); margin: 0 0 var(--space-4); line-height:1.55; opacity:' + (isAfter ? '0.92' : '0.8') + ';'}>\${data.body}</p>\`}
      \${Array.isArray(data.bullets) && data.bullets.length > 0 && html\`<ul style="list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap: var(--space-2);">
        \${data.bullets.map(line => html\`<li style="display:flex; gap: var(--space-2); align-items:flex-start; font-size: var(--text-sm); line-height:1.5;">
          <span style=\${'flex-shrink:0; opacity:' + (isAfter ? '1' : '0.55') + ';'}>\${isAfter ? '→' : '·'}</span>
          <span>\${line}</span>
        </li>\`)}
      </ul>\`}
    </div>
  \`;
  return html\`
    <section style="padding: var(--space-24) 0; border-top: 1px solid var(--brand-border);">
      <div class="container">
        \${eyebrow && html\`<p style="font-size: var(--text-xs); letter-spacing:.12em; text-transform:uppercase; color: var(--brand-muted); margin: 0 0 var(--space-3);">\${eyebrow}</p>\`}
        \${title && html\`<h2 class="heading" style="font-size: var(--text-4xl); margin: 0 0 var(--space-12); max-width: 28ch;">\${title}</h2>\`}
        <div style=\${'display:grid; grid-template-columns: ' + gridColsFor(2, 320) + '; gap: var(--space-4);'}>
          \${panel(b, false)}
          \${panel(a, true)}
        </div>
      </div>
    </section>
  \`;
}

/**
 * Banner — top-of-page announcement strip. Goes ABOVE Nav. Single
 * short message + optional CTA. Used for launch announcements, sale
 * notices, "we raised X" strips. Closes on click.
 *
 * props: { message, ctaLabel?, ctaHref?, variant?: 'info'|'success'|'warn' }
 */
export function Banner({ message, ctaLabel, ctaHref, variant }) {
  const palette = {
    info:    { bg: 'var(--brand-primary)', fg: 'var(--brand-on-primary, white)' },
    success: { bg: '#10b981',              fg: 'white' },
    warn:    { bg: '#f59e0b',              fg: 'black' },
  };
  const v = palette[variant] || palette.info;
  return html\`
    <div role="region" aria-label="Announcement" style=\${'background:' + v.bg + '; color:' + v.fg + '; padding: var(--space-3) var(--space-4); text-align:center; font-size: var(--text-sm); display:flex; gap: var(--space-3); justify-content:center; align-items:center; flex-wrap:wrap;'}>
      <span>\${message || ''}</span>
      \${ctaLabel && html\`<a href=\${ctaHref || '#'} style=\${'color: inherit; text-decoration: underline; font-weight: 600;'}>\${ctaLabel} →</a>\`}
    </div>
  \`;
}

/**
 * Lightweight escape hatch for one-off sections the library doesn't cover.
 * props: { title?, body? }   — replace via the agent when needed.
 */
export function PlaceholderSection({ title, body }) {
  return html\`
    <section style="padding: var(--space-16) 0; border-top: 1px solid var(--brand-border);">
      <div class="container">
        <h2 class="heading" style="font-size: var(--text-3xl); margin: 0 0 var(--space-3);">\${title || 'Section'}</h2>
        <p style="color: var(--brand-muted); max-width: 64ch;">\${body || 'Placeholder content — replace via the agent.'}</p>
      </div>
    </section>
  \`;
}
`;

/* ---------------------------------------------------------------------------
 * Page template: page.js (declarative section list)
 * ------------------------------------------------------------------------- */

export const PAGE_TEMPLATE_PAGE_JS = `/**
 * Ordered list of section blocks rendered by app.js.
 *
 * The page starts empty on purpose — the agent appends ONE block at a time
 * via Edit, then calls PAGE_PREVIEW_REFRESH. Each refresh adds one section
 * to the preview with a staggered fade-in.
 *
 * Each block is { section: '<ExportName from sections.js>', props: { ... } }.
 *
 * Available sections (see sections.js):
 *   Nav, Hero, FeatureGrid, PricingCards, TestimonialQuote, LogoStrip,
 *   FAQ, EmailCapture, CTASection, Footer, PlaceholderSection
 *
 * Example, after editing:
 *   export const PAGE = [
 *     { section: 'Nav',         props: { title: 'Acme' } },
 *     { section: 'Hero',        props: { title: 'Ship faster', subtitle: '…', ctaPrimary: 'Start' } },
 *     { section: 'FeatureGrid', props: { title: 'Features', items: [{ title: '…', body: '…' }] } },
 *     { section: 'Footer',      props: {} },
 *   ];
 */
export const PAGE = [];
`;
