import { chromium } from "playwright";
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { mapBounded, retry } from "@decocms/shared/std";

const { values } = parseArgs({
  options: {
    storefront: { type: "string" },
    url: { type: "string", default: "http://127.0.0.1:4110" },
    reports: { type: "string" },
    diagnostic: { type: "string" },
    output: { type: "string" },
  },
});
if (
  !values.storefront ||
  !values.reports ||
  !values.diagnostic ||
  !values.output
)
  throw new Error(
    "Usage: bun run demo:prepare --storefront CHECKOUT --url DEV_URL --reports REPORTS_CHECKOUT --diagnostic PUBLIC_DIAGNOSTIC_JSON --output BUNDLE_JSON",
  );
const storefront = resolve(values.storefront);
const reports = resolve(values.reports);
async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  if (await p.exited) throw new Error(`Git ${args[0]} failed`);
  return out.trim();
}
const remote = await git(storefront, "remote", "get-url", "origin");
const repository = remote.match(
  /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/,
)?.[1];
if (!repository) throw new Error("Expected a GitHub storefront checkout");
const headerPath = "src/sections/Header/Header.tsx";
if (await git(storefront, "diff", "HEAD", "--", headerPath))
  throw new Error("Header has local edits; use a clean checkout");
const original = await readFile(join(storefront, headerPath), "utf8");
const diagnostic = JSON.parse(await readFile(values.diagnostic, "utf8"));
if (!diagnostic.sections?.length || !diagnostic.meta?.url)
  throw new Error("No public diagnostic sections");
const assets: Record<string, { mime: string; body: string }> = {};
const cache = new Map<string, Promise<string>>();
async function asset(url: string): Promise<string> {
  if (url.startsWith("data:") || url.startsWith("#")) return url;
  let pending = cache.get(url);
  if (!pending) {
    pending = (async () => {
      const target = new URL(url, values.url);
      // Older Reports payloads appended image options with & instead of ?.
      if (/\.(?:png|jpe?g|webp|svg)&/.test(target.pathname)) {
        const [pathname, ...query] = target.pathname.split("&");
        target.pathname = pathname!;
        target.search = query.join("&");
      }
      if (!["http:", "https:"].includes(target.protocol))
        throw new Error("Unsupported asset URL");
      const response = await retry(
        () => fetch(target, { signal: AbortSignal.timeout(20_000) }),
        { maxAttempts: 3, minTimeout: 1000, maxTimeout: 3000 },
      ).catch(() => {
        throw new Error(
          `Asset download timed out at ${target.origin}${target.pathname}`,
        );
      });
      if (!response.ok)
        throw new Error(
          `Asset preparation failed (${response.status}) at ${target.origin}${target.pathname} (${target.searchParams.get("src") ?? ""})`,
        );
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 10_000_000) throw new Error("Asset exceeds 10 MB");
      const mime =
        response.headers.get("content-type")?.split(";")[0] ??
        "application/octet-stream";
      if (
        !/^(image\/|font\/|application\/(font|x-font|octet-stream))/.test(mime)
      )
        throw new Error(
          `Unexpected asset type ${mime} at ${target.origin}${target.pathname}`,
        );
      const hash = createHash("sha256").update(bytes).digest("hex");
      assets[hash] = { mime, body: bytes.toString("base64") };
      return `__DEMO_ASSET_BASE__/${hash}`;
    })();
    cache.set(url, pending);
  }
  return pending;
}
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const behavior = await readFile(
  new URL("./storefront-behavior.js", import.meta.url),
  "utf8",
);
async function capture() {
  await retry(() => page.goto(values.url!, { waitUntil: "domcontentloaded" }), {
    maxAttempts: 3,
    minTimeout: 500,
    maxTimeout: 1500,
  });
  await page.locator("h1").first().waitFor();
  // Capture the repository's DOM and computed stylesheet rules, excluding hydration payloads.
  const snapshot = await page.evaluate(() => {
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    root
      .querySelectorAll("script, link, template, vite-error-overlay, iframe")
      .forEach((n) => n.remove());
    root.querySelectorAll("*").forEach((node) => {
      for (const attr of [...node.attributes])
        if (attr.name.startsWith("on") || attr.name.startsWith("hx-"))
          node.removeAttribute(attr.name);
    });
    const images = [...root.querySelectorAll<HTMLImageElement>("img")]
      .map((img) => {
        const url = img.getAttribute("src") || "";
        img.removeAttribute("srcset");
        img.removeAttribute("sizes");
        img.loading = "eager";
        return url;
      })
      .filter(Boolean);
    root.querySelectorAll("source").forEach((n) => n.remove());
    const css = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText);
        } catch {
          return [];
        }
      })
      .join("\n");
    const sprites = [...root.querySelectorAll("use")]
      .map((node) => node.getAttribute("href")?.split("#")[0])
      .filter((url): url is string => !!url);
    return { html: "<!doctype html>" + root.outerHTML, css, images, sprites };
  });
  let css = snapshot.css;
  const cssUrls = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)]
    .map((m) => m[1]!)
    .filter(
      (u) =>
        !u.startsWith("data:") && !u.startsWith("#") && !u.startsWith("%23"),
    );
  let html = snapshot.html;
  const urls = [
    ...new Set([...snapshot.images, ...snapshot.sprites, ...cssUrls]),
  ];
  const replacements = await mapBounded(
    urls,
    6,
    async (url) => [url, await asset(url)] as const,
  );
  for (const [url, local] of replacements) {
    html = html.replaceAll(url.replaceAll("&", "&amp;"), local);
    css = css.replaceAll(url, local);
  }
  return html
    .replace("</head>", `<style>${css}</style></head>`)
    .replace("</body>", `<script>${behavior}</script></body>`);
}
try {
  console.log("Capturing repository baseline");
  const base = await capture();
  const searchMarkup = `<div data-prepared-search="" style={{ margin: "0 12px 8px auto", maxWidth: 430, padding: 12, background: "rgba(255,255,255,.96)", borderRadius: 12, boxShadow: "0 4px 16px #0001" }}>
        <form role="search"><input type="search" aria-label="Search products" placeholder="What are you looking for?" style={{ width: "100%", padding: "8px 12px", border: "1px solid #ccc", borderRadius: 6 }} /><div data-search-results="" role="region" aria-live="polite" /></form>
      </div>`;
  const searchSource = original.replace(
    "    </header>",
    `      ${searchMarkup}\n    </header>`,
  );
  if (searchSource === original)
    throw new Error("Header shape changed; update the prepared patch");
  await writeFile(join(storefront, headerPath), searchSource);
  const searchDiff = await git(storefront, "diff", "--", headerPath);
  console.log("Capturing search patch");
  const search = await capture();
  const promotionMarkup = `<div data-prepared-promotion="" style={{ textAlign: "center", background: "#bfff00", color: "#111", padding: "10px 16px", fontWeight: 600 }}><a href="#featured">New season · Up to 60% off</a> · Ends in <span data-countdown="">23:59:59</span></div>`;
  const promotionSource = original.replace(
    "      {alerts.length > 0 && (",
    `      ${promotionMarkup}\n      {alerts.length > 0 && (`,
  );
  await writeFile(join(storefront, headerPath), promotionSource);
  const promotionDiff = await git(storefront, "diff", "--", headerPath);
  console.log("Capturing promotion patch");
  const promotion = await capture();
  await writeFile(
    join(storefront, headerPath),
    searchSource.replace(
      "      {alerts.length > 0 && (",
      `      ${promotionMarkup}\n      {alerts.length > 0 && (`,
    ),
  );
  const combined = await capture();
  // Existing Reports imagery is captured as data URIs so its unmodified iframe needs no network.
  async function localize(value: unknown, key = ""): Promise<unknown> {
    if (
      typeof value === "string" &&
      /^https?:/.test(value) &&
      (/screenshot|image|logo|favicon|src/i.test(key) ||
        /\.(png|jpe?g|webp)(\?|$)/i.test(value))
    ) {
      const path = await asset(value);
      const item = assets[path.split("/").at(-1)!]!;
      return `data:${item.mime};base64,${item.body}`;
    }
    if (Array.isArray(value))
      return mapBounded(value, 6, (v) => localize(v, key));
    if (value && typeof value === "object") {
      const entries = await mapBounded(
        Object.entries(value),
        6,
        async ([k, v]) => [k, await localize(v, k)],
      );
      return Object.fromEntries(entries);
    }
    return value;
  }
  console.log("Capturing Reports assets");
  const report = await localize(diagnostic);
  const commit = await git(storefront, "rev-parse", "HEAD");
  const cart = await readFile(
    join(storefront, "src/components/minicart/MinicartDrawer.tsx"),
    "utf8",
  );
  const bundle = {
    version: 1,
    source: {
      repository,
      commit,
      reportsCommit: await git(reports, "rev-parse", "HEAD"),
      siteUrl: diagnostic.meta.url,
      capturedAt: new Date().toISOString(),
    },
    assets,
    storefront: {
      base,
      search,
      promotion,
      diagnostic: base,
      "search,promotion": combined,
      "search,diagnostic": search,
      "promotion,diagnostic": promotion,
      "search,promotion,diagnostic": combined,
    },
    reportsHtml: await readFile(
      join(reports, "dist/client/index.html"),
      "utf8",
    ),
    diagnostic: report,
    recipes: {
      search: {
        title: "Make product search visible in the header",
        description:
          "Colocar o Search mais visível para a busca de produtos no Header",
        steps: [
          "The repository keeps search in the menu. I prepared a visible field using the storefront's header and catalog.",
          "The preview retains the existing storefront and adds product suggestions from its captured catalog.",
          "The prepared preview is ready. Search for a catalog item and review the header change.",
        ],
        result: "Product search is visible in the storefront header.",
        diff: searchDiff,
      },
      promotion: {
        title: "Add a colorful promotional bar with a countdown",
        description:
          "Faça uma nova proposta de top-bar, com um countdown para uma nova promoção, e algo mais colorido",
        steps: [
          "I used the repository's New Season campaign and header as the starting point.",
          "The new promotional bar uses the store's lime accent, a countdown and a link to the featured products.",
          "The prepared preview is ready for design review.",
        ],
        result:
          "The New Season promotion appears above the existing navigation with a countdown.",
        diff: promotionDiff,
      },
      diagnostic: {
        title: "Verify the report's cart accessibility finding",
        description:
          "Reports flagged a focusable, aria-hidden minicart checkbox (A11Y-028). Check the pinned repository before proposing another fix: the report may predate the code.",
        steps: [
          "The captured Reports diagnostic includes A11Y-028 for the minicart control.",
          `At repository commit ${commit.slice(0, 12)}, the checkbox already has aria-label=Cart and no aria-hidden. The captured report is older than this fix.`,
          "No additional source change is needed for this finding. The preview preserves the existing correction; review the report evidence and current source together.",
        ],
        result:
          "The pinned repository already fixes the cart checkbox finding. No new code change is claimed.",
        diff: `Verification only — no source change.\n\n${repository}@${commit}\nsrc/components/minicart/MinicartDrawer.tsx\n\n${cart}`,
      },
    },
  };
  await writeFile(values.output, JSON.stringify(bundle));
  console.log(
    `Prepared ${repository}@${commit.slice(0, 12)} with ${diagnostic.sections.length} Reports sections and ${Object.keys(assets).length} captured assets: ${values.output}`,
  );
} finally {
  await writeFile(join(storefront, headerPath), original);
  await browser.close();
}
