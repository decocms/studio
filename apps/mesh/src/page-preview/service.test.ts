import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDesignSystemExportBundle,
  buildPageExportBundle,
  createDesignSystem,
  createPage,
  defaultBrand,
  discoverHtmlPages,
  getPagePreviewPaths,
  getPagePreviewStatus,
  refreshPagePreview,
  setActiveDesignSystem,
  setPagePreviewActive,
} from "./service";
import { contrastRatio, parseHex } from "./contrast";

const ORG_ID = "org/test";
const ORG_SLUG = "acme";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "page-preview-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function writePage(relativePath: string, body = "<!doctype html>") {
  const { pagesDir } = getPagePreviewPaths({ orgId: ORG_ID, dataDir });
  const absolutePath = join(pagesDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, body, "utf8");
  return absolutePath;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("page preview service", () => {
  test("uses one well-known local pages directory for every org", () => {
    const first = getPagePreviewPaths({ orgId: "org-one", dataDir });
    const second = getPagePreviewPaths({ orgId: "org-two", dataDir });

    expect(first.pagesDir).toBe(join(dataDir, "page-editor", "pages"));
    expect(second.pagesDir).toBe(first.pagesDir);
    expect(second.statePath).toBe(first.statePath);
    expect(first.designSystemsDir).toBe(
      join(dataDir, "page-editor", "design-systems"),
    );
  });

  test("normalizes page slug to index.html and sets active preview", async () => {
    const absolutePath = await writePage("pricing/index.html");

    const status = await setPagePreviewActive({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      path: "pricing",
    });

    expect(status.activePath).toBe(absolutePath);
    expect(status.activeRelativePath).toBe("pages/pricing/index.html");
    expect(status.activeKind).toBe("page");
    expect(status.refreshVersion).toBe(1);
    expect(status.activeUrl).toBe(
      "http://localhost:3000/api/acme/page-preview/files/pages/pricing/index.html?v=1",
    );
  });

  test("accepts absolute HTML paths inside the pages directory", async () => {
    const absolutePath = await writePage("absolute/index.html");

    const status = await setPagePreviewActive({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      path: absolutePath,
    });

    expect(status.activePath).toBe(absolutePath);
    expect(status.activeRelativePath).toBe("pages/absolute/index.html");
  });

  test("rejects relative traversal outside the pages directory", async () => {
    await expect(
      setPagePreviewActive({
        orgId: ORG_ID,
        dataDir,
        path: "../escape/index.html",
      }),
    ).rejects.toThrow();
  });

  test("rejects absolute paths outside the pages directory", async () => {
    const outsidePath = join(dataDir, "outside.html");
    await writeFile(outsidePath, "<!doctype html>", "utf8");

    await expect(
      setPagePreviewActive({
        orgId: ORG_ID,
        dataDir,
        path: outsidePath,
      }),
    ).rejects.toThrow();
  });

  test("discovers HTML pages under the local pages directory", async () => {
    await writePage("landing/index.html");
    await writePage("pricing/index.html");
    await writePage("pricing/app.js", "console.log('ignored')");

    const pages = await discoverHtmlPages({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
    });

    expect(pages.map((p) => p.slug).sort()).toEqual(["landing", "pricing"]);
    expect(pages.every((p) => p.relativePath.endsWith("/index.html"))).toBe(
      true,
    );
  });

  test("refresh increments version and preserves the active page", async () => {
    await writePage("launch/index.html");
    await setPagePreviewActive({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      path: "launch/index.html",
    });

    const refreshed = await refreshPagePreview({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
    });

    expect(refreshed.activeRelativePath).toBe("pages/launch/index.html");
    expect(refreshed.refreshVersion).toBe(2);
    expect(refreshed.activeUrl).toContain("?v=2");
  });

  test("status falls back to the newest discovered page when no active page is set", async () => {
    await writePage("fallback/index.html");

    const status = await getPagePreviewStatus({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
    });

    expect(status.activeRelativePath).toBe("pages/fallback/index.html");
    expect(status.activeKind).toBe("page");
    expect(status.refreshVersion).toBe(0);
  });

  test("status switches to a newer page written after the active page was set", async () => {
    await writePage("first/index.html");
    await setPagePreviewActive({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      path: "first/index.html",
    });

    await sleep(10);
    await writePage("second/index.html");

    const status = await getPagePreviewStatus({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
    });

    expect(status.activeRelativePath).toBe("pages/second/index.html");
  });
});

describe("design system scaffolding", () => {
  test("creates a design system with tokens, demo and meta", async () => {
    const brand = { ...defaultBrand(), primary: "#FF00AA" };
    const { slug, status } = await createDesignSystem({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      slug: "Pristine!",
      name: "Pristine",
      brand,
    });

    expect(slug).toBe("pristine");
    expect(status.activeKind).toBe("design-system");
    expect(status.activeDesignSystem).toBe("pristine");
    expect(status.designSystems).toHaveLength(1);
    expect(status.designSystems[0]?.brand.primary).toBe("#FF00AA");

    const root = join(dataDir, "page-editor", "design-systems", "pristine");
    const tokensCss = await readFile(join(root, "tokens.css"), "utf8");
    expect(tokensCss).toContain("--brand-primary: #FF00AA");
    const meta = JSON.parse(await readFile(join(root, "meta.json"), "utf8"));
    expect(meta.brand.primary).toBe("#FF00AA");
  });

  test("setActiveDesignSystem requires the design system to exist", async () => {
    await expect(
      setActiveDesignSystem({
        orgId: ORG_ID,
        dataDir,
        slug: "ghost",
      }),
    ).rejects.toThrow();
  });

  test("progress label is set by setPageProgress and cleared by scaffold/refresh", async () => {
    const { setPageProgress } = await import("./service");
    const set = await setPageProgress({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      label: "Picking a design system…",
    });
    expect(set.progressLabel).toBe("Picking a design system…");

    const created = await createDesignSystem({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      slug: "pristine",
      brand: defaultBrand(),
    });
    expect(created.status.progressLabel).toBeNull();

    const set2 = await setPageProgress({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      label: "Building the hero",
    });
    expect(set2.progressLabel).toBe("Building the hero");

    const refreshed = await refreshPagePreview({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
    });
    expect(refreshed.progressLabel).toBeNull();
  });

  test("auto-corrects illegible muted/border on a light bg", async () => {
    const { status } = await createDesignSystem({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      slug: "lavender",
      brand: {
        ...defaultBrand(),
        bg: "#F3EBFF",
        surface: "#FFFFFF",
        fg: "#1A1A1A",
        // Agent supplied an illegible pastel for muted and a vivid yellow
        // for border — exactly the kind of mistake we want to correct.
        muted: "#E5DDF3",
        border: "#FFE600",
      },
    });
    const ds = status.designSystems.find((d) => d.slug === "lavender")!;
    const bg = parseHex(ds.brand.bg)!;
    const muted = parseHex(ds.brand.muted)!;
    expect(contrastRatio(muted, bg)).toBeGreaterThanOrEqual(5.5);
    // border has a softer threshold but must still be visible.
    const border = parseHex(ds.brand.border)!;
    expect(contrastRatio(border, bg)).toBeGreaterThanOrEqual(1.5);
    // fg must hit AAA.
    const fg = parseHex(ds.brand.fg)!;
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(7);
  });

  test("auto-corrects illegible muted on a dark bg", async () => {
    const { status } = await createDesignSystem({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      slug: "deepnight",
      brand: {
        ...defaultBrand(),
        bg: "#0B0B12",
        surface: "#15151F",
        fg: "#F6F6F8",
        muted: "#1A1A22", // way too dark on dark bg
        border: "#181820",
      },
    });
    const ds = status.designSystems.find((d) => d.slug === "deepnight")!;
    const bg = parseHex(ds.brand.bg)!;
    const muted = parseHex(ds.brand.muted)!;
    expect(contrastRatio(muted, bg)).toBeGreaterThanOrEqual(5.5);
  });
});

describe("page scaffolding", () => {
  test("creates a page bound to an existing design system", async () => {
    await createDesignSystem({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      slug: "pristine",
      brand: defaultBrand(),
    });

    const { slug, status } = await createPage({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      slug: "Landing!",
      designSystem: "pristine",
      title: "Landing",
      description: "A new landing page",
    });

    expect(slug).toBe("landing");
    // Default: do NOT switch preview to the new (empty) page; keep design
    // system visible until the agent edits page.js + calls PAGE_PREVIEW_SET.
    expect(status.activeKind).toBe("design-system");
    expect(status.activeDesignSystem).toBe("pristine");

    const pageDir = join(dataDir, "page-editor", "pages", "landing");
    const index = await readFile(join(pageDir, "index.html"), "utf8");
    expect(index).toContain("<title>Landing</title>");
    expect(index).toContain("../../design-systems/pristine/tokens.css");
    const meta = JSON.parse(await readFile(join(pageDir, "meta.json"), "utf8"));
    expect(meta.designSystem).toBe("pristine");
    // page.js ships empty so the page renders the EmptyPageState until the
    // agent populates it.
    const pageJs = await readFile(join(pageDir, "page.js"), "utf8");
    expect(pageJs).toMatch(/export const PAGE = \[\];?\s*$/);
  });

  test("createPage with activate=true switches the preview immediately", async () => {
    await createDesignSystem({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      slug: "pristine",
      brand: defaultBrand(),
    });
    const { status } = await createPage({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      slug: "landing",
      designSystem: "pristine",
      activate: true,
    });
    expect(status.activeKind).toBe("page");
    expect(status.activeRelativePath).toBe("pages/landing/index.html");
  });

  test("rejects page creation when the design system does not exist", async () => {
    await expect(
      createPage({
        orgId: ORG_ID,
        dataDir,
        slug: "landing",
        designSystem: "ghost",
      }),
    ).rejects.toThrow();
  });
});

describe("export", () => {
  test("page export bundles a self-contained index.html plus raw src/", async () => {
    await createDesignSystem({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      slug: "pristine",
      brand: defaultBrand(),
    });
    await createPage({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      slug: "landing",
      designSystem: "pristine",
    });

    const { bundleName, files } = await buildPageExportBundle({
      orgId: ORG_ID,
      dataDir,
      slug: "landing",
    });
    expect(bundleName).toBe("page-landing");

    const names = files.map((f) => f.relativePath).sort();
    expect(names).toContain("index.html");
    expect(names).toContain("README.txt");
    expect(names).toContain("src/index.html");
    expect(names).toContain("src/app.js");
    expect(names).toContain("src/tokens.css");
    expect(names).toContain("src/tokens.js");

    const dec = new TextDecoder();
    const indexHtml = dec.decode(
      files.find((f) => f.relativePath === "index.html")!.data,
    );
    // Stylesheet must be inlined; no remaining ../../design-systems ref.
    expect(indexHtml).not.toContain("../../design-systems");
    expect(indexHtml).toContain("<style>");
    expect(indexHtml).toContain("--brand-primary");
    // app.js script-src is replaced with an inline module that no longer
    // imports from same-folder relatives.
    expect(indexHtml).toContain('<script type="module">');
    expect(indexHtml).not.toMatch(/src=["']\.\/app\.js["']/);
    expect(indexHtml).not.toMatch(/from\s+['"]\.\/sections\.js['"]/);
    expect(indexHtml).not.toMatch(/from\s+['"]\.\/page\.js['"]/);
    // BRAND must be defined inline (no longer imported).
    expect(indexHtml).toMatch(/(?:^|\n)\s*const BRAND\s*=/);
    // Each chunk used to redeclare `const html = htm.bind(h)` — concatenation
    // produced a SyntaxError. After hoisting the binding once at the top of
    // the consolidated module, exactly one declaration should remain.
    const htmlBindCount = (
      indexHtml.match(/const\s+html\s*=\s*htm\.bind\(h\)/g) ?? []
    ).length;
    expect(htmlBindCount).toBe(1);
    // Same story for `import { h ... } from 'preact'` — one canonical import.
    const preactImportCount = (
      indexHtml.match(/import\s+\{[^}]*\}\s*from\s+['"]preact['"]/g) ?? []
    ).length;
    expect(preactImportCount).toBe(1);
    // `app.js` does `Sections[block.section]` — after we strip the
    // `import * as Sections` line, the inline bundle must reconstruct a
    // `Sections` namespace from the section function names.
    expect(indexHtml).toMatch(
      /(?:^|\n)\s*const\s+Sections\s*=\s*\{\s*[A-Z][A-Za-z0-9_$]*/,
    );
    // Spot-check a couple of well-known section names are inside the
    // synthesized namespace.
    expect(indexHtml).toMatch(/const\s+Sections\s*=\s*\{[^}]*\bHero\b/);
    expect(indexHtml).toMatch(/const\s+Sections\s*=\s*\{[^}]*\bNav\b/);
  });

  test("design-system export bundles a self-contained demo.html", async () => {
    await createDesignSystem({
      orgId: ORG_ID,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      dataDir,
      slug: "pristine",
      brand: defaultBrand(),
    });

    const { bundleName, files } = await buildDesignSystemExportBundle({
      orgId: ORG_ID,
      dataDir,
      slug: "pristine",
    });
    expect(bundleName).toBe("design-system-pristine");
    const names = files.map((f) => f.relativePath).sort();
    expect(names).toContain("demo.html");
    expect(names).toContain("tokens.css");

    const dec = new TextDecoder();
    const demoHtml = dec.decode(
      files.find((f) => f.relativePath === "demo.html")!.data,
    );
    // demo.js external script is replaced with an inline module.
    expect(demoHtml).not.toMatch(/src=["']\.\/demo\.js["']/);
    expect(demoHtml).toContain('<script type="module">');
    expect(demoHtml).toMatch(/(?:^|\n)\s*const BRAND\s*=/);
  });
});
