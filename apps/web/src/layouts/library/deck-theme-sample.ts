/**
 * Sample slide sections for the deck-theme viewer — one `<section>` per slide
 * template (matching slide-templates/*.html in the slides skill), with
 * brand-neutral placeholder content. Injected into a theme shell's
 * `{{{slides}}}` so opening a brand's slides-theme.html renders the whole deck
 * in the brand style instead of an empty canvas. Mirrors the skill's class
 * contract (deck-h1, eyebrow, bullets, cols, kpi-value, step, …).
 */

export const DECK_SAMPLE_TITLE = "Theme preview";

export const DECK_SAMPLE_SECTIONS = [
  // title
  `<section class="slide-center">
    <p class="eyebrow">Brand deck</p>
    <h1 class="deck-h1">Your brand, on every slide</h1>
    <p class="deck-sub">A live preview of each slide layout in your brand style.</p>
    <p class="deck-meta">Theme preview</p>
  </section>`,
  // agenda
  `<section>
    <p class="eyebrow">Agenda</p>
    <h2 class="deck-h2">What's in this theme</h2>
    <ol class="agenda">
      <li>Title &amp; section dividers</li>
      <li>Bulleted content</li>
      <li>Side-by-side columns</li>
      <li>Metrics &amp; timelines</li>
      <li>Quotes &amp; closing</li>
    </ol>
  </section>`,
  // section-divider
  `<section class="slide-center divider">
    <p class="giant-number">01</p>
    <h2 class="deck-h1">Content layouts</h2>
    <p class="deck-sub">How text-heavy slides look.</p>
  </section>`,
  // bullets
  `<section>
    <p class="eyebrow">Bullets</p>
    <h2 class="deck-h2">Key points land cleanly</h2>
    <p class="deck-body intro">Short, scannable lines with the brand accent marker.</p>
    <ul class="bullets">
      <li>Each point is one idea</li>
      <li>Accent color draws the eye</li>
      <li>Plenty of breathing room</li>
    </ul>
  </section>`,
  // two-column
  `<section>
    <p class="eyebrow">Two column</p>
    <h2 class="deck-h2">Compare side by side</h2>
    <div class="cols">
      <div class="card grow">
        <h3 class="col-title">Before</h3>
        <div class="deck-body"><p>Generic slides that ignore your brand.</p></div>
      </div>
      <div class="card grow">
        <h3 class="col-title">After</h3>
        <div class="deck-body"><p>Every deck on-brand, automatically.</p></div>
      </div>
    </div>
  </section>`,
  // kpi-row
  `<section>
    <p class="eyebrow">Metrics</p>
    <h2 class="deck-h2">Numbers that matter</h2>
    <div class="cols kpis">
      <div class="card kpi grow">
        <p class="kpi-value">3&times;</p>
        <p class="kpi-label">Faster deck creation</p>
        <p class="kpi-delta">since adopting the theme</p>
      </div>
      <div class="card kpi grow">
        <p class="kpi-value">100%</p>
        <p class="kpi-label">On-brand slides</p>
        <p class="kpi-delta">no manual restyling</p>
      </div>
      <div class="card kpi grow">
        <p class="kpi-value">1</p>
        <p class="kpi-label">Source of truth</p>
        <p class="kpi-delta">tokens.css</p>
      </div>
    </div>
  </section>`,
  // timeline
  `<section>
    <p class="eyebrow">Timeline</p>
    <h2 class="deck-h2">How it unfolds</h2>
    <div class="cols timeline">
      <div class="step grow">
        <p class="step-label">Step 1</p>
        <h3 class="col-title">Define</h3>
        <p class="deck-body">Set brand tokens once.</p>
      </div>
      <div class="step grow">
        <p class="step-label">Step 2</p>
        <h3 class="col-title">Generate</h3>
        <p class="deck-body">Create decks from data.</p>
      </div>
      <div class="step grow">
        <p class="step-label">Step 3</p>
        <h3 class="col-title">Present</h3>
        <p class="deck-body">Ship, always on-brand.</p>
      </div>
    </div>
  </section>`,
  // comparison
  `<section>
    <p class="eyebrow">Comparison</p>
    <h2 class="deck-h2">Plans at a glance</h2>
    <div class="cols">
      <div class="card grow">
        <h3 class="col-title">Starter</h3>
        <ul class="bullets compact">
          <li>Core layouts</li>
          <li>Brand colors</li>
          <li>Logo</li>
        </ul>
      </div>
      <div class="card grow">
        <h3 class="col-title">Pro</h3>
        <ul class="bullets compact">
          <li>Everything in Starter</li>
          <li>Custom fonts</li>
          <li>Theme shell</li>
        </ul>
      </div>
    </div>
  </section>`,
  // quote
  `<section class="slide-center">
    <blockquote class="deck-quote">&ldquo;Design once, stay on-brand everywhere.&rdquo;</blockquote>
    <p class="attribution">Brand system &middot; Studio</p>
  </section>`,
  // closing
  `<section class="slide-center">
    <h2 class="deck-h1">Ready to present</h2>
    <p class="deck-sub">Generate a deck with this theme via the slides skill.</p>
    <p class="cta">slides-create --theme &hellip;</p>
  </section>`,
].join("\n\n");
