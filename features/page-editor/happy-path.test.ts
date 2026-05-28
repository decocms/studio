/**
 * Page Editor happy-path harness.
 *
 * This is the executable contract for the Page Editor feature. Read
 * features/page-editor/feature.md FIRST. The phases here mirror the
 * "Happy path" section of that doc.
 *
 * Run: `bun run features:test page-editor`
 *
 * The test drives the service layer directly — the same code path the
 * agent's MCP tools call internally — using DevObjectStorage backed by
 * a per-test tmpdir. No HTTP server, no browser, no dev server
 * dependency. Phase F (browser leg) is a planned follow-up; when it
 * ships it will live next to this file behind a `PW=1` env gate.
 *
 * If you change Page Editor and this test breaks, follow the Loop in
 * feature.md > Maintenance. Don't loosen this test to make a green
 * build — fix the divergence, OR change the test deliberately and
 * update feature.md alongside it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DevObjectStorage } from "../../apps/mesh/src/object-storage/dev-object-storage";
import {
  appendBlock,
  buildPageExportBundle,
  cleanupPageEditorStorage,
  createDesignSystem,
  createPage,
  DEFAULT_BRAND,
  getBlocks,
  getPagePreviewStatus,
  resetBlocks,
  sanitizeBlockProps,
  setPageProgress,
} from "../../apps/mesh/src/page-preview/service";
import { STUDIO_PACK_AGENTS } from "../../apps/mesh/src/tools/virtual/studio-pack";
import { pageEditorAgent } from "../../apps/mesh/src/tools/virtual/studio-pack/page-editor";
import { StudioPackAgentId } from "../../packages/mesh-sdk/src/lib/constants";

/* ---------------------------------------------------------------------------
 * Tmpdir + DevObjectStorage isolation
 *
 * DevObjectStorage writes to ./data/assets/<orgId>/ relative to cwd, so
 * we chdir into a fresh tmpdir per test. Same pattern used by
 * apps/mesh/src/page-preview/service.test.ts.
 * ------------------------------------------------------------------------- */

let cwdDir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  cwdDir = await mkdtemp(join(tmpdir(), "page-editor-harness-"));
  process.chdir(cwdDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(cwdDir, { recursive: true, force: true });
});

function makeStorage(orgId: string): DevObjectStorage {
  return new DevObjectStorage(orgId);
}

/* ---------------------------------------------------------------------------
 * The canonical agent build sequence.
 *
 * Mirrors what a real Page Editor agent emits during a build: PROGRESS
 * (latest outline), BOOTSTRAP (DS + page in one call), then one
 * RENDER_BLOCK per outline entry, in order.
 *
 * For the harness we call createDesignSystem + createPage + appendBlock
 * directly — same code path the MCP tools invoke internally. The HTTP
 * layer is covered by unit tests in apps/mesh/src/page-preview/
 * service.test.ts; this harness owns the AGENT FLOW.
 * ------------------------------------------------------------------------- */

const OUTLINE = ["Nav", "Hero", "FeatureGrid", "CTASection", "Footer"];
const ORG_A = "harness-org-a";
const ORG_B = "harness-org-b";
const PAGE_SLUG = "funnel-ai";
const DS_SLUG = `${PAGE_SLUG}-ds`;

async function driveAgentBuild(
  storage: DevObjectStorage,
  orgId: string,
  slug = PAGE_SLUG,
) {
  const baseOptions = {
    orgId,
    objectStorage: storage,
    orgSlug: orgId,
    baseUrl: "http://localhost:3000",
  };

  // Step 4 of the happy path: PROGRESS lands first with the outline.
  await setPageProgress({
    ...baseOptions,
    label: "Starting…",
    outline: OUTLINE,
  });

  // Step 5: BOOTSTRAP — the curated theme + the DS + the page + the
  // outline arrive in one shot. Real-world tool implementation chains
  // createDesignSystem then createPage.
  await createDesignSystem({
    ...baseOptions,
    slug: DS_SLUG,
    name: "Funnel AI",
    template: "electric-indigo",
    brand: { ...DEFAULT_BRAND, name: "Funnel AI" },
  });
  await createPage({
    ...baseOptions,
    slug,
    designSystem: DS_SLUG,
    title: "Funnel AI",
    description: "AI revenue assistant for B2B SaaS",
    // PAGE_BOOTSTRAP passes activate:true so the page becomes the
    // visible preview the moment the agent starts shipping blocks.
    activate: true,
  });

  // Step 6: one RENDER_BLOCK per outline entry, in order. Props are
  // representative of what the agent would actually ship — short, no
  // AI-slop, definition-first per the system prompt's copy contract.
  const blockPropsBySection: Record<string, Record<string, unknown>> = {
    Nav: {
      title: "Funnel AI",
      ctaLabel: "Start free trial",
      ctaHref: "/signup",
      links: [
        { label: "Features", href: "#features" },
        { label: "Pricing", href: "#pricing" },
      ],
    },
    Hero: {
      title: "Cut deal-cycle time by 28%",
      subtitle:
        "Funnel AI is an AI revenue assistant for B2B SaaS sales teams. It surfaces buyer intent signals across 12 data sources.",
      ctaPrimary: "Start free trial",
      ctaPrimaryHref: "/signup",
    },
    FeatureGrid: {
      title: "What you get",
      items: [
        {
          title: "Intent signals",
          body: "Auto-detects buyer activity across CRMs.",
        },
        {
          title: "Pipeline scoring",
          body: "Ranks deals by close probability daily.",
        },
        {
          title: "Slack alerts",
          body: "Notifies reps the moment intent fires.",
        },
      ],
    },
    CTASection: {
      title: "See Funnel AI in your CRM",
      ctaPrimary: "Start free trial",
      ctaPrimaryHref: "/signup",
    },
    Footer: { brand: { name: "Funnel AI" } },
  };

  for (const section of OUTLINE) {
    await appendBlock({
      ...baseOptions,
      slug,
      block: { section, props: blockPropsBySection[section]! },
    });
  }
}

/* ---------------------------------------------------------------------------
 * Phase A — Studio Pack contract
 *
 * The Page Editor must be registered as a Studio Pack default agent, and
 * its definition must carry the metadata that routes the panel to the
 * iframe. Without these the feature is silently broken for new orgs.
 * ------------------------------------------------------------------------- */

describe("Phase A — Studio Pack contract", () => {
  test("pageEditorAgent is in STUDIO_PACK_AGENTS", () => {
    const ids = STUDIO_PACK_AGENTS.map((a) => a.id);
    expect(ids).toContain("studio-page-editor");
  });

  test("agent has the expected shape (id, icon, getId, selectedTools)", () => {
    expect(pageEditorAgent.id).toBe("studio-page-editor");
    expect(typeof pageEditorAgent.icon).toBe("string");
    expect(pageEditorAgent.icon.length).toBeGreaterThan(0);
    expect(pageEditorAgent.getId("test-org")).toBe(
      "studio-page-editor_test-org",
    );
    expect(pageEditorAgent.getId).toBe(StudioPackAgentId.PAGE_EDITOR);

    // Tools that drive the build must all be in selectedTools — without
    // these the agent can't actually do its job. This list is the
    // minimum bar; adding more here is fine, removing breaks the build.
    const required = [
      "PAGE_PREVIEW_PROGRESS",
      "PAGE_BOOTSTRAP",
      "PAGE_RENDER_BLOCK",
      "PAGE_UPDATE_BLOCK",
      "PAGE_REMOVE_BLOCK",
      "PAGE_REVIEW_SUGGEST",
      "DESIGN_SYSTEM_CREATE",
      "PAGE_PREVIEW_PAGE_CREATE",
    ];
    for (const tool of required) {
      expect(pageEditorAgent.selectedTools).toContain(tool);
    }
  });

  test("agent declares defaultMainView=page-preview", () => {
    // This is the single field that makes the iframe panel render. If
    // it's absent or wrong, every new org has a Page Editor agent that
    // shows plain chat with no preview.
    expect("defaultMainView" in pageEditorAgent).toBe(true);
    expect(pageEditorAgent.defaultMainView).toEqual({ type: "page-preview" });
  });

  test("agent's INSTRUCTIONS embed the curated theme table", () => {
    // C7 in the simplification pass: the theme catalogue is built at
    // module load from DEFAULT_THEMES so it can't drift. Spot-check
    // that some known slugs survived the materialization.
    expect(pageEditorAgent.instructions).toContain("electric-indigo");
    expect(pageEditorAgent.instructions).toContain("cyber-lime");
    expect(pageEditorAgent.instructions).toContain("editorial-serif");
  });
});

/* ---------------------------------------------------------------------------
 * Phase B & C — Drive the build, assert server state
 *
 * Walk the agent's tool sequence end-to-end against one org's storage,
 * then snapshot the state and verify it matches the happy path.
 * ------------------------------------------------------------------------- */

describe("Phase B & C — Drive the build, assert state", () => {
  test("the full agent sequence lands a page with the outline order intact", async () => {
    const storage = makeStorage(ORG_A);
    resetBlocks({
      orgId: ORG_A,
      objectStorage: storage,
      orgSlug: ORG_A,
      baseUrl: "http://localhost:3000",
      slug: PAGE_SLUG,
    });

    await driveAgentBuild(storage, ORG_A);

    const status = await getPagePreviewStatus({
      orgId: ORG_A,
      objectStorage: storage,
      orgSlug: ORG_A,
      baseUrl: "http://localhost:3000",
    });

    // Active artifact is the page (not the DS) once blocks have shipped.
    expect(status.activeKind).toBe("page");
    expect(status.activeRelativePath).toBe(`pages/${PAGE_SLUG}/index.html`);
    expect(status.activeDesignSystem).toBe(DS_SLUG);

    // The page is discoverable in storage and bound to its DS.
    const page = status.pages.find((p) => p.slug === PAGE_SLUG);
    expect(page).toBeDefined();
    expect(page!.designSystem).toBe(DS_SLUG);

    // The DS is discoverable and has the merged brand (template + name).
    const ds = status.designSystems.find((d) => d.slug === DS_SLUG);
    expect(ds).toBeDefined();
    expect(ds!.brand.name).toBe("Funnel AI");

    // The outline made it into state.json via the PROGRESS call.
    expect(status.outline).toEqual(OUTLINE);

    // refreshVersion has been bumped past zero by the chain of
    // createDesignSystem → createPage → 5× appendBlock (each appendBlock
    // calls bumpRefreshVersion). Exact value isn't a contract, just
    // "monotonic and > 0".
    expect(status.refreshVersion).toBeGreaterThan(0);

    // The live block list matches the outline ORDER. This is the most
    // user-visible contract: the iframe renders top-to-bottom in the
    // order RENDER_BLOCK was called.
    const blocks = getBlocks({
      orgId: ORG_A,
      objectStorage: storage,
      orgSlug: ORG_A,
      baseUrl: "http://localhost:3000",
      slug: PAGE_SLUG,
    });
    expect(blocks.map((b) => b.section)).toEqual(OUTLINE);

    // Spot-check that every block's props survived (the sanitizer
    // doesn't strip non-URL fields).
    const hero = blocks.find((b) => b.section === "Hero")!;
    expect(hero.props.title).toBe("Cut deal-cycle time by 28%");
  });

  test("malicious href props collapse to '#' on the way into storage", async () => {
    // The XSS sanitizer in service.ts must catch javascript: URLs
    // before they hit the block list. Mirrored by the iframe-side
    // sanitizer in host-html.ts.
    const storage = makeStorage(ORG_A);
    resetBlocks({
      orgId: ORG_A,
      objectStorage: storage,
      orgSlug: ORG_A,
      baseUrl: "http://localhost:3000",
      slug: PAGE_SLUG,
    });

    await createDesignSystem({
      orgId: ORG_A,
      objectStorage: storage,
      orgSlug: ORG_A,
      baseUrl: "http://localhost:3000",
      slug: DS_SLUG,
      name: "Funnel AI",
      brand: DEFAULT_BRAND,
    });
    await createPage({
      orgId: ORG_A,
      objectStorage: storage,
      orgSlug: ORG_A,
      baseUrl: "http://localhost:3000",
      slug: PAGE_SLUG,
      designSystem: DS_SLUG,
    });
    await appendBlock({
      orgId: ORG_A,
      objectStorage: storage,
      orgSlug: ORG_A,
      baseUrl: "http://localhost:3000",
      slug: PAGE_SLUG,
      block: {
        section: "Hero",
        props: {
          title: "Welcome",
          ctaPrimaryHref: "javascript:alert('xss')",
        },
      },
    });

    const [block] = getBlocks({
      orgId: ORG_A,
      objectStorage: storage,
      orgSlug: ORG_A,
      baseUrl: "http://localhost:3000",
      slug: PAGE_SLUG,
    });
    expect(block!.props.ctaPrimaryHref).toBe("#");

    // The exported sanitizer is the same function tools/service uses.
    // Asserting it covers the same shape gives us defense-in-depth for
    // anyone bypassing appendBlock to write into storage by hand.
    const sanitized = sanitizeBlockProps({ ctaHref: "vbscript:msgbox(1)" });
    expect(sanitized.ctaHref).toBe("#");
  });
});

/* ---------------------------------------------------------------------------
 * Phase D — Multi-tenant isolation
 *
 * Org A and Org B share the bucket; they MUST NOT share content. This
 * is the blocker the storage migration closed; the harness pins it.
 * ------------------------------------------------------------------------- */

describe("Phase D — Multi-tenant isolation", () => {
  test("org A's bindings cannot see org B's page even with the same slug", async () => {
    const storageA = makeStorage(ORG_A);
    const storageB = makeStorage(ORG_B);

    await driveAgentBuild(storageA, ORG_A);
    await driveAgentBuild(storageB, ORG_B);

    const statusA = await getPagePreviewStatus({
      orgId: ORG_A,
      objectStorage: storageA,
      orgSlug: ORG_A,
      baseUrl: "http://localhost:3000",
    });
    const statusB = await getPagePreviewStatus({
      orgId: ORG_B,
      objectStorage: storageB,
      orgSlug: ORG_B,
      baseUrl: "http://localhost:3000",
    });

    // Each org's status reports exactly one page — its own.
    expect(statusA.pages.map((p) => p.slug)).toEqual([PAGE_SLUG]);
    expect(statusB.pages.map((p) => p.slug)).toEqual([PAGE_SLUG]);

    // The signed URLs are scoped per orgSlug — cross-pollination would
    // show up as one org's URL pointing into another's content.
    expect(statusA.activeUrl).toContain(`/${ORG_A}/`);
    expect(statusB.activeUrl).toContain(`/${ORG_B}/`);
    expect(statusA.activeUrl).not.toContain(`/${ORG_B}/`);
    expect(statusB.activeUrl).not.toContain(`/${ORG_A}/`);
  });

  test("cleanupPageEditorStorage wipes the prefix for one org without touching the other", async () => {
    // Mirrors the vMCP delete path: when the Page Editor agent is
    // deleted for an org, only THAT org's storage gets pruned.
    const storageA = makeStorage(ORG_A);
    const storageB = makeStorage(ORG_B);
    await driveAgentBuild(storageA, ORG_A);
    await driveAgentBuild(storageB, ORG_B);

    await cleanupPageEditorStorage(storageA);

    const remainingA = await storageA.list({ prefix: "page-preview/" });
    const remainingB = await storageB.list({ prefix: "page-preview/" });
    expect(remainingA.objects.length).toBe(0);
    expect(remainingB.objects.length).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------------------
 * Phase E — Export bundle
 *
 * The agent's user-visible output is a self-contained ZIP. The export
 * must inline tokens, reconstruct the Sections namespace, and emit
 * JSON-LD + llms.txt + robots.txt for AI search visibility.
 * ------------------------------------------------------------------------- */

describe("Phase E — Export bundle", () => {
  test("the page export is a self-contained zip with the SEO artifacts", async () => {
    const storage = makeStorage(ORG_A);
    resetBlocks({
      orgId: ORG_A,
      objectStorage: storage,
      orgSlug: ORG_A,
      baseUrl: "http://localhost:3000",
      slug: PAGE_SLUG,
    });
    await driveAgentBuild(storage, ORG_A);

    const { bundleName, files } = await buildPageExportBundle({
      orgId: ORG_A,
      objectStorage: storage,
      slug: PAGE_SLUG,
    });
    expect(bundleName).toBe(`page-${PAGE_SLUG}`);

    const names = files.map((f) => f.relativePath).sort();
    // Top-level files for a finished page.
    expect(names).toContain("index.html");
    expect(names).toContain("llms.txt");
    expect(names).toContain("robots.txt");
    expect(names).toContain("README.txt");
    // Raw source files for advanced editing.
    expect(names).toContain("src/index.html");
    expect(names).toContain("src/app.js");
    expect(names).toContain("src/page.js");
    expect(names).toContain("src/sections.js");
    expect(names).toContain("src/tokens.css");
    expect(names).toContain("src/tokens.js");

    const dec = new TextDecoder();
    const indexHtml = dec.decode(
      files.find((f) => f.relativePath === "index.html")!.data,
    );
    // CSS inlined — no ../../design-systems references survive.
    expect(indexHtml).not.toContain("../../design-systems");
    expect(indexHtml).toContain("<style>");
    // The inlined module reconstructs the Sections namespace so app.js
    // can do Sections[block.section] after the strip-imports pass.
    expect(indexHtml).toMatch(/const\s+Sections\s*=\s*\{[^}]*\bHero\b/);
    expect(indexHtml).toMatch(/const\s+Sections\s*=\s*\{[^}]*\bNav\b/);
    expect(indexHtml).toMatch(/const\s+Sections\s*=\s*\{[^}]*\bFooter\b/);
    // Exactly one preact import + one htm bind at the top of the inline
    // module — duplicate imports would re-declare and throw at load.
    expect(
      (indexHtml.match(/import\s+\{[^}]*\}\s*from\s+['"]preact['"]/g) ?? [])
        .length,
    ).toBe(1);
    expect(
      (indexHtml.match(/const\s+html\s*=\s*htm\.bind\(h\)/g) ?? []).length,
    ).toBe(1);

    // JSON-LD @graph lands in <head> — server-rendered because AI
    // crawlers don't execute JS.
    expect(indexHtml).toContain('<script type="application/ld+json">');

    // Every file has real bytes (no empty zip entries that would
    // silently break the downloaded archive).
    for (const f of files) {
      expect(f.data.byteLength).toBeGreaterThan(0);
    }
  });
});

/* ---------------------------------------------------------------------------
 * Phase F — Browser leg
 *
 * Lives in apps/mesh/e2e/tests/features/page-editor.browser.spec.ts so
 * the existing Playwright config + auth fixtures apply. Runs via
 * `PW=1 bun run features:test page-editor` — the harness CLI shells
 * out to playwright after the data-path phases pass.
 *
 * It asserts the user-visible boot contract: signup auto-installs the
 * Studio Pack, the Page Editor agent surfaces in the agents list,
 * clicking it routes the panel to the iframe (defaultMainView wiring),
 * and the iframe's preact bundle executes through to the welcome
 * quiz. Driving an actual agent build through the browser is a
 * separate, slower test reserved for nightly.
 * ------------------------------------------------------------------------- */
