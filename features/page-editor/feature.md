# Page Editor

> The agent that builds landing pages section-by-section in a live preview pane.

## What it does

Page Editor is a Studio Pack built-in agent that builds structured landing
pages (and adjacent doc types — memos, OKR briefs, blog posts) by issuing
JSON tool calls that the Studio iframe renders in real time. The agent never
edits source files directly: it ships a `PAGE_BOOTSTRAP` with an outline and a
theme, then one `PAGE_RENDER_BLOCK` per section, then closes with a review
pass. Each section animates into the iframe as its tool call lands, so the
user watches the page assemble in front of them in ~25–30 seconds.

The output is exportable as a self-contained ZIP (single inlined HTML, with
JSON-LD + llms.txt + an AI-crawler-friendly robots.txt baked in) so a finished
page is ready to publish anywhere with zero build steps.

## Why it matters

A landing page is a conversion funnel, and a conversion funnel is a story.
Page Editor is the only feature in Studio that lets the agent **tell that
story while the user watches**, instead of dropping a finished artifact at the
end. The choreography itself is the value — it makes the agent's reasoning
legible, gives the user a "I can stop you mid-build" affordance, and lets the
review pass propose copy fixes against sections the user is still looking at.

Brand Manager's `pages/<slug>.html` mode covers raw-HTML one-offs. Page Editor
covers everything that benefits from a structured section model: marketing
sites, product pages, memos, comparison tables, roadmaps, status updates.

## Happy path

The story we promise. If any step breaks, the feature is broken:

1. A fresh org installs the Studio Pack → `studio-page-editor_<orgId>` vMCP
   exists with `metadata.ui.layout.defaultMainView.type === "page-preview"`.
2. The user opens the Page Editor agent in a fresh chat.
3. The user types a one-line prompt ("build me a landing page for an AI
   invoice tool").
4. The agent emits `PAGE_PREVIEW_PROGRESS({ label: "Starting…" })` within ~1 s
   of the message landing.
5. The agent emits `PAGE_BOOTSTRAP({ slug, template, outline })`. The outline
   is 5–9 sections in conversion order (Nav first, Footer last). The DS slug
   is derived as `<slug>-ds`. Storage now has
   `page-preview/design-systems/<slug>-ds/*` and
   `page-preview/pages/<slug>/*` keys.
6. The agent ships one `PAGE_RENDER_BLOCK` per outline entry, in order. The
   chat-stream watcher in `page-preview-tab.tsx` translates each into a
   `host:render-block` postMessage. The iframe reveals each section with a
   minimum 1.5 s gap (`MIN_REVEAL_INTERVAL_MS`) so the user can read what just
   landed before the next scrolls into view.
7. After Footer lands, the agent ends its turn with **ONE** short question
   asking whether the user wants a review pass.
8. The user says yes; the agent ships 2–3 `PAGE_REVIEW_SUGGEST` calls. Each
   surfaces as a glassy tooltip pinned to its section in the iframe with
   Accept / Dismiss buttons.
9. The page can be downloaded as a ZIP via
   `GET /api/{org}/page-preview/export?kind=page&slug=<slug>`. The ZIP contains
   one self-contained `index.html` (inlined CSS + JS, JSON-LD `@graph` in
   `<head>`, FAQPage when the page ships a FAQ) plus `llms.txt`, `robots.txt`,
   and `src/` with the raw source files.

## How to verify

`bun run features:test page-editor` runs the executable contract. Phases:

- **Setup** — fresh org + user, install Studio Pack, assert the Page Editor
  vMCP exists with the right id and `defaultMainView` shape.
- **Drive** — open an MCP session against the Page Editor vMCP and call the
  tool sequence (PROGRESS → BOOTSTRAP → 5× RENDER_BLOCK → REVIEW_SUGGEST × 2).
- **Assert** — server state matches the happy path:
  `state.activeKind === "page"`, `state.refreshVersion` bumped, every outline
  section is in storage in order, the export bundle's `index.html` has the
  JSON-LD and the inlined module reconstructs the `Sections` namespace.
- **Multi-tenant** — a second org with the same slug cannot read the first
  org's page from object storage.
- **Browser (PW=1 only)** — sign up via Better Auth, navigate to the Page
  Editor agent, assert the iframe loads with the welcome quiz mounted. Spec
  at `apps/mesh/e2e/tests/features/page-editor.browser.spec.ts`.

If any phase fails, the harness prints which assertion failed and which
file owns the contract that broke.

## Exploratory verification with Webwright

The Playwright spec above is deterministic and runs in CI — it asserts the
boot contract. For richer, agent-driven validation (a real LLM driving the
whole agent build through the browser, taking screenshots, comparing them
against the happy path) install [Webwright](https://github.com/microsoft/Webwright)
as a Claude Code skill:

```bash
/plugin install webwright@webwright
```

Then point it at the happy path with a task description like:

> Sign up at https://localhost:3000/login as a new user. Wait for the home
> page to load. Click "Page Editor" in the agents list. In the chat,
> send "build me a landing page for an AI invoice tool". Wait for the
> agent to ship sections; the iframe on the right should show, in order:
> Nav → Hero → Features → CTA → Footer. Take a screenshot of the
> finished page. Verify each outline section is visible by reading the
> DOM headings.

Webwright generates a re-runnable Python Playwright script + screenshots +
an action log. It's slower and non-deterministic (LLM in the loop) but
catches things the boot-level spec misses — copy rendering, scroll
choreography, review-tip tooltips, paced reveals. Treat its outputs as
evidence for a human reviewer, not a replacement for the canonical spec.

## Files that implement this feature

- `apps/mesh/src/tools/page-preview/index.ts` — MCP tool surface
- `apps/mesh/src/page-preview/service.ts` — persistence, state, export, sanitization
- `apps/mesh/src/page-preview/host-html.ts` — the iframe runtime (preact + htm)
- `apps/mesh/src/page-preview/templates.ts` — ~24 section templates
- `apps/mesh/src/page-preview/default-themes.ts` — 10 curated themes
- `apps/mesh/src/page-preview/contrast.ts` — WCAG contrast enforcement
- `apps/mesh/src/api/routes/page-preview.ts` — HTTP routes (host shell, state, export, host-version)
- `apps/mesh/src/web/layouts/main-panel-tabs/page-preview-tab.tsx` — Studio-side tab + chat-stream watcher
- `apps/mesh/src/tools/virtual/studio-pack/page-editor.ts` — the agent definition (id, icon, INSTRUCTIONS, selected tools, `defaultMainView`)
- `apps/mesh/src/auth/install-studio-pack-workflow.ts` — auto-install on `org.afterCreate`

## Maintenance (THE LOOP)

Every time you touch any file in the list above, follow this:

1. **Run `bun run features:test page-editor` first.** It must pass on the
   current code. If it doesn't, that's a P0 — fix the divergence (or fix the
   test if the contract genuinely changed) before doing anything else.

2. **Write the test for your change.** Extend `happy-path.test.ts` with the
   new behavior. The new test should fail (RED) on the current code, before
   you write any implementation.

3. **Implement until the test passes** (GREEN). Loop: refine test, refine
   code, refine this `feature.md` if the story shifted.

4. **Update the prompt at the bottom of this file** if an AI agent extending
   this feature in the future would benefit from new context.

5. **Only then ask a human to verify.** If they reject the result, edit the
   `feature.md` happy path to capture the new expectation, fail the test
   against the new expectation, and loop.

The point is: humans don't have time to verify every keystroke at the pace
this codebase ships. The harness is the contract. Humans verify *the
contract*, not every implementation.

## Prompt for AI agents (read this before touching the feature)

You are about to modify the Page Editor. Read this entire `feature.md` first.

The contract you are inheriting:

- **The iframe is Studio-controlled.** The page being built lives inside an
  `<iframe>` whose runtime is served by `GET /api/{org}/page-preview/host`.
  The runtime listens for `host:*` postMessages from the parent (Studio) and
  drives a preact render loop.
- **The agent never edits files.** It only emits `PAGE_*` tool calls. The
  chat-stream watcher in `page-preview-tab.tsx` translates those into the
  postMessages the iframe consumes. There is no other path.
- **Storage is org-scoped object storage.** All persistence flows through
  `ctx.objectStorage` (`BoundObjectStorage`) under the `page-preview/`
  prefix. See `apps/mesh/src/page-preview/service.ts`. Never re-introduce a
  disk-based fallback.
- **The Page Editor vMCP is auto-installed** as a Studio Pack agent on
  `org.afterCreate` (see `install-studio-pack-workflow.ts`). The vMCP has
  `metadata.ui.layout.defaultMainView.type = "page-preview"`, which is what
  routes the panel to the iframe. Without that field, the user sees plain
  chat and the feature is silently broken.
- **The chat-stream watcher dedupes by `toolCallId`** so stream replays don't
  double-dispatch. It also resets when `taskId` changes so positional
  fallbacks don't collide across chats.
- **URL props are sanitized** at write time (`sanitizeBlockProps` in
  `service.ts`) AND at iframe render time (mirror in `host-html.ts`).
  Anything matching `/^(href|src|.*Href|.*Src)$/i` with a `javascript:` or
  `data:` scheme gets collapsed to `#`.
- **Studio Pack agents are listed in `STUDIO_PACK_AGENTS`** in
  `apps/mesh/src/tools/virtual/studio-pack/index.ts`. Page Editor is one of
  them. Removing it from the array removes the feature for new orgs.

If your change touches any of: the tool surface, storage layout, the iframe
runtime, the panel routing, the chat-stream watcher, or the agent's system
prompt — **extend `happy-path.test.ts` to cover the new shape BEFORE
writing the implementation**. The test is the contract.
