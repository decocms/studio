import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DevObjectStorage } from "@/object-storage/dev-object-storage";
import { getSettings } from "@/settings";
import {
  buildDesignSystemExportBundle,
  buildPageExportBundle,
  createDesignSystem,
  createPage,
  DEFAULT_BRAND,
  discoverHtmlPages,
  getPagePreviewStatus,
  refreshPagePreview,
  sanitizeBlockProps,
  setActiveDesignSystem,
  setPagePreviewActive,
} from "./service";
import { contrastRatio, parseHex } from "./contrast";

const ORG_ID = "org-test";
const ORG_SLUG = "acme";

// DevObjectStorage writes under ./data/assets/<orgId>/ relative to cwd. We
// can't redirect it via a constructor arg (the path is baked in), so we cd
// into a temp dir per test to isolate the on-disk footprint. The encryption
// key isn't relevant for the methods we exercise.
let originalCwd: string;
let cwdDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  cwdDir = await mkdtemp(join(tmpdir(), "page-preview-"));
  process.chdir(cwdDir);
  // DevObjectStorage signs presigned URLs against settings.encryptionKey; we
  // don't generate any URLs in these tests so the default is fine.
  void getSettings();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(cwdDir, { recursive: true, force: true });
});

function makeStorage(orgId = ORG_ID): DevObjectStorage {
  return new DevObjectStorage(orgId);
}

async function writePage(
  storage: DevObjectStorage,
  slug: string,
  body = "<!doctype html>",
) {
  await storage.put(`page-preview/pages/${slug}/index.html`, body, {
    contentType: "text/html; charset=utf-8",
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("sanitizeBlockProps", () => {
  test("collapses javascript: hrefs to '#'", () => {
    const sanitized = sanitizeBlockProps({
      ctaLabel: "Click",
      ctaHref: "javascript:alert('xss')",
      ctaPrimaryHref: " JAVASCRIPT:alert(1)",
      links: [
        { label: "Docs", href: "https://example.com" },
        { label: "Bad", href: "javascript:void(0)" },
      ],
    });
    expect(sanitized.ctaHref).toBe("#");
    expect(sanitized.ctaPrimaryHref).toBe("#");
    const links = sanitized.links as { href: string }[];
    expect(links[0]!.href).toBe("https://example.com");
    expect(links[1]!.href).toBe("#");
  });

  test("preserves http/https/mailto/tel and relative URLs", () => {
    const ok = sanitizeBlockProps({
      a: { href: "https://example.com" },
      b: { href: "http://example.com" },
      c: { href: "mailto:hi@example.com" },
      d: { href: "tel:+15551234567" },
      e: { href: "#anchor" },
      f: { href: "/relative" },
      g: { href: "without-scheme/path" },
    });
    expect((ok.a as { href: string }).href).toBe("https://example.com");
    expect((ok.b as { href: string }).href).toBe("http://example.com");
    expect((ok.c as { href: string }).href).toBe("mailto:hi@example.com");
    expect((ok.d as { href: string }).href).toBe("tel:+15551234567");
    expect((ok.e as { href: string }).href).toBe("#anchor");
    expect((ok.f as { href: string }).href).toBe("/relative");
    expect((ok.g as { href: string }).href).toBe("without-scheme/path");
  });

  test("rejects data:text/html and vbscript:", () => {
    const sanitized = sanitizeBlockProps({
      img: { src: "data:text/html;base64,PHNjcmlwdD4=" },
      x: { src: "vbscript:msgbox(1)" },
    });
    expect((sanitized.img as { src: string }).src).toBe("#");
    expect((sanitized.x as { src: string }).src).toBe("#");
  });

  test("leaves non-URL keys untouched", () => {
    const sanitized = sanitizeBlockProps({
      title: "javascript: this is not a URL",
      body: "Some text",
    });
    expect(sanitized.title).toBe("javascript: this is not a URL");
    expect(sanitized.body).toBe("Some text");
  });
});

describe("page preview service — multi-tenant isolation", () => {
  test("org A's bindings cannot see org B's pages", async () => {
    const storageA = makeStorage("org-A");
    const storageB = makeStorage("org-B");

    await writePage(storageA, "alpha", "<html>org A page</html>");
    await writePage(storageB, "beta", "<html>org B page</html>");

    const pagesA = await discoverHtmlPages({
      orgId: "org-A",
      objectStorage: storageA,
      orgSlug: "org-a",
      baseUrl: "http://localhost:3000",
    });
    const pagesB = await discoverHtmlPages({
      orgId: "org-B",
      objectStorage: storageB,
      orgSlug: "org-b",
      baseUrl: "http://localhost:3000",
    });

    expect(pagesA.map((p) => p.slug).sort()).toEqual(["alpha"]);
    expect(pagesB.map((p) => p.slug).sort()).toEqual(["beta"]);
  });
});

describe("page preview service", () => {
  let storage: DevObjectStorage;
  beforeEach(() => {
    storage = makeStorage();
  });

  test("normalizes page slug to index.html and sets active preview", async () => {
    await writePage(storage, "pricing");

    const status = await setPagePreviewActive({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      path: "pricing",
    });

    expect(status.activeRelativePath).toBe("pages/pricing/index.html");
    expect(status.activeKind).toBe("page");
    expect(status.refreshVersion).toBe(1);
    expect(status.activeUrl).toBe(
      "http://localhost:3000/api/acme/files/page-preview/pages/pricing/index.html?v=1",
    );
  });

  test("accepts relative paths under pages/", async () => {
    await writePage(storage, "relative");

    const status = await setPagePreviewActive({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      path: "pages/relative/index.html",
    });

    expect(status.activeRelativePath).toBe("pages/relative/index.html");
  });

  test("rejects paths that don't resolve to a stored page", async () => {
    await expect(
      setPagePreviewActive({
        orgId: ORG_ID,
        objectStorage: storage,
        orgSlug: ORG_SLUG,
        baseUrl: "http://localhost:3000",
        path: "nope/index.html",
      }),
    ).rejects.toThrow();
  });

  test("rejects non-HTML paths", async () => {
    await storage.put("page-preview/pages/img/logo.png", "fake-png", {
      contentType: "image/png",
    });

    await expect(
      setPagePreviewActive({
        orgId: ORG_ID,
        objectStorage: storage,
        orgSlug: ORG_SLUG,
        baseUrl: "http://localhost:3000",
        path: "pages/img/logo.png",
      }),
    ).rejects.toThrow();
  });

  test("discovers HTML pages under the pages prefix", async () => {
    await writePage(storage, "landing");
    await writePage(storage, "pricing");
    // Sibling non-index file should be ignored by discovery.
    await storage.put(
      "page-preview/pages/pricing/app.js",
      "console.log('ignored')",
      { contentType: "application/javascript" },
    );

    const pages = await discoverHtmlPages({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
    });

    expect(pages.map((p) => p.slug).sort()).toEqual(["landing", "pricing"]);
    expect(pages.every((p) => p.relativePath.endsWith("/index.html"))).toBe(
      true,
    );
  });

  test("refresh increments version and preserves the active page", async () => {
    await writePage(storage, "launch");
    await setPagePreviewActive({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      path: "launch",
    });

    const refreshed = await refreshPagePreview({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
    });

    expect(refreshed.activeRelativePath).toBe("pages/launch/index.html");
    expect(refreshed.refreshVersion).toBe(2);
    expect(refreshed.activeUrl).toContain("?v=2");
  });

  test("status falls back to the newest discovered page when no active page is set", async () => {
    await writePage(storage, "fallback");

    const status = await getPagePreviewStatus({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
    });

    expect(status.activeRelativePath).toBe("pages/fallback/index.html");
    expect(status.activeKind).toBe("page");
    expect(status.refreshVersion).toBe(0);
  });

  test("status switches to a newer page written after the active page was set", async () => {
    await writePage(storage, "first");
    await setPagePreviewActive({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      path: "first",
    });

    await sleep(10);
    await writePage(storage, "second");

    const status = await getPagePreviewStatus({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
    });

    expect(status.activeRelativePath).toBe("pages/second/index.html");
  });
});

describe("design system scaffolding", () => {
  let storage: DevObjectStorage;
  beforeEach(() => {
    storage = makeStorage();
  });

  test("creates a design system with tokens, demo and meta", async () => {
    const brand = { ...DEFAULT_BRAND, primary: "#FF00AA" };
    const { slug, status } = await createDesignSystem({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      slug: "Pristine!",
      name: "Pristine",
      brand,
    });

    expect(slug).toBe("pristine");
    expect(status.activeKind).toBe("design-system");
    expect(status.activeDesignSystem).toBe("pristine");
    expect(status.designSystems).toHaveLength(1);
    expect(status.designSystems[0]?.brand.primary).toBe("#FF00AA");

    const tokensCssRes = await storage.get(
      "page-preview/design-systems/pristine/tokens.css",
    );
    if ("error" in tokensCssRes) throw new Error("tokens.css too large");
    expect(tokensCssRes.content).toContain("--brand-primary: #FF00AA");

    const metaRes = await storage.get(
      "page-preview/design-systems/pristine/meta.json",
    );
    if ("error" in metaRes) throw new Error("meta.json too large");
    const meta = JSON.parse(metaRes.content);
    expect(meta.brand.primary).toBe("#FF00AA");
  });

  test("setActiveDesignSystem requires the design system to exist", async () => {
    await expect(
      setActiveDesignSystem({
        orgId: ORG_ID,
        objectStorage: storage,
        orgSlug: ORG_SLUG,
        baseUrl: "http://localhost:3000",
        slug: "ghost",
      }),
    ).rejects.toThrow();
  });

  test("progress label is set by setPageProgress and cleared by scaffold/refresh", async () => {
    const { setPageProgress } = await import("./service");
    const set = await setPageProgress({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      label: "Picking a design system…",
    });
    expect(set.progressLabel).toBe("Picking a design system…");

    const created = await createDesignSystem({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      slug: "pristine",
      brand: DEFAULT_BRAND,
    });
    expect(created.status.progressLabel).toBeNull();

    const set2 = await setPageProgress({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      label: "Building the hero",
    });
    expect(set2.progressLabel).toBe("Building the hero");

    const refreshed = await refreshPagePreview({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
    });
    expect(refreshed.progressLabel).toBeNull();
  });

  test("auto-corrects illegible muted/border on a light bg", async () => {
    const { status } = await createDesignSystem({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      slug: "lavender",
      brand: {
        ...DEFAULT_BRAND,
        bg: "#F3EBFF",
        surface: "#FFFFFF",
        fg: "#1A1A1A",
        muted: "#E5DDF3",
        border: "#FFE600",
      },
    });
    const ds = status.designSystems.find((d) => d.slug === "lavender")!;
    const bg = parseHex(ds.brand.bg)!;
    const muted = parseHex(ds.brand.muted)!;
    expect(contrastRatio(muted, bg)).toBeGreaterThanOrEqual(5.5);
    const border = parseHex(ds.brand.border)!;
    expect(contrastRatio(border, bg)).toBeGreaterThanOrEqual(1.5);
    const fg = parseHex(ds.brand.fg)!;
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(7);
  });

  test("auto-corrects illegible muted on a dark bg", async () => {
    const { status } = await createDesignSystem({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      slug: "deepnight",
      brand: {
        ...DEFAULT_BRAND,
        bg: "#0B0B12",
        surface: "#15151F",
        fg: "#F6F6F8",
        muted: "#1A1A22",
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
  let storage: DevObjectStorage;
  beforeEach(() => {
    storage = makeStorage();
  });

  test("creates a page bound to an existing design system", async () => {
    await createDesignSystem({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      slug: "pristine",
      brand: DEFAULT_BRAND,
    });

    const { slug, status } = await createPage({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      slug: "Landing!",
      designSystem: "pristine",
      title: "Landing",
      description: "A new landing page",
    });

    expect(slug).toBe("landing");
    expect(status.activeKind).toBe("design-system");
    expect(status.activeDesignSystem).toBe("pristine");

    const indexRes = await storage.get("page-preview/pages/landing/index.html");
    if ("error" in indexRes) throw new Error("index.html too large");
    expect(indexRes.content).toContain("<title>Landing</title>");
    expect(indexRes.content).toContain(
      "../../design-systems/pristine/tokens.css",
    );

    const metaRes = await storage.get("page-preview/pages/landing/meta.json");
    if ("error" in metaRes) throw new Error("meta.json too large");
    const meta = JSON.parse(metaRes.content);
    expect(meta.designSystem).toBe("pristine");

    const pageJsRes = await storage.get("page-preview/pages/landing/page.js");
    if ("error" in pageJsRes) throw new Error("page.js too large");
    expect(pageJsRes.content).toMatch(/export const PAGE = \[\];?\s*$/);
  });

  test("createPage with activate=true switches the preview immediately", async () => {
    await createDesignSystem({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      slug: "pristine",
      brand: DEFAULT_BRAND,
    });
    const { status } = await createPage({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
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
        objectStorage: storage,
        orgSlug: ORG_SLUG,
        baseUrl: "http://localhost:3000",
        slug: "landing",
        designSystem: "ghost",
      }),
    ).rejects.toThrow();
  });
});

describe("export", () => {
  let storage: DevObjectStorage;
  beforeEach(() => {
    storage = makeStorage();
  });

  test("page export bundles a self-contained index.html plus raw src/", async () => {
    await createDesignSystem({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      slug: "pristine",
      brand: DEFAULT_BRAND,
    });
    await createPage({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      slug: "landing",
      designSystem: "pristine",
    });

    const { bundleName, files } = await buildPageExportBundle({
      orgId: ORG_ID,
      objectStorage: storage,
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
    expect(indexHtml).not.toContain("../../design-systems");
    expect(indexHtml).toContain("<style>");
    expect(indexHtml).toContain("--brand-primary");
    expect(indexHtml).toContain('<script type="module">');
    expect(indexHtml).not.toMatch(/src=["']\.\/app\.js["']/);
    expect(indexHtml).not.toMatch(/from\s+['"]\.\/sections\.js['"]/);
    expect(indexHtml).not.toMatch(/from\s+['"]\.\/page\.js['"]/);
    expect(indexHtml).toMatch(/(?:^|\n)\s*const BRAND\s*=/);
    const htmlBindCount = (
      indexHtml.match(/const\s+html\s*=\s*htm\.bind\(h\)/g) ?? []
    ).length;
    expect(htmlBindCount).toBe(1);
    const preactImportCount = (
      indexHtml.match(/import\s+\{[^}]*\}\s*from\s+['"]preact['"]/g) ?? []
    ).length;
    expect(preactImportCount).toBe(1);
    expect(indexHtml).toMatch(
      /(?:^|\n)\s*const\s+Sections\s*=\s*\{\s*[A-Z][A-Za-z0-9_$]*/,
    );
    expect(indexHtml).toMatch(/const\s+Sections\s*=\s*\{[^}]*\bHero\b/);
    expect(indexHtml).toMatch(/const\s+Sections\s*=\s*\{[^}]*\bNav\b/);
  });

  test("design-system export bundles a self-contained demo.html", async () => {
    await createDesignSystem({
      orgId: ORG_ID,
      objectStorage: storage,
      orgSlug: ORG_SLUG,
      baseUrl: "http://localhost:3000",
      slug: "pristine",
      brand: DEFAULT_BRAND,
    });

    const { bundleName, files } = await buildDesignSystemExportBundle({
      orgId: ORG_ID,
      objectStorage: storage,
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
    expect(demoHtml).not.toMatch(/src=["']\.\/demo\.js["']/);
    expect(demoHtml).toContain('<script type="module">');
    expect(demoHtml).toMatch(/(?:^|\n)\s*const BRAND\s*=/);
  });
});
