/**
 * Mock data for the scripted demo task board. A fictional apparel and
 * home-goods storefront ("Acme Store") whose backlog is generated from
 * GA4, Search Console and GitHub signals. Everything here is static and
 * deterministic: no network, no randomness.
 */

import type { TaskBoardItemPriority, TaskBoardItemStatus } from "../config";

export type DemoSource = "ga4" | "gsc" | "github";

export interface DemoPrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface DemoPr {
  number: number;
  title: string;
  branch: string;
  additions: number;
  deletions: number;
  summary: string[];
  files: DemoPrFile[];
}

export interface DemoSessionStep {
  text: string;
  time: string;
}

export interface DemoSession {
  startedBy: string;
  startedAgo: string;
  /** Status line shown while the task is still in progress. */
  workingStatus: string;
  steps: DemoSessionStep[];
}

export interface DemoCmsFix {
  /** Label of the field the agent edited, e.g. "Meta description". */
  fieldLabel: string;
  /** The new value written by the agent. */
  fieldValue: string;
  /** Short pill text shown on the preview near the fixed element. */
  previewNote: string;
}

export interface DemoTaskSeed {
  id: string;
  key: string;
  title: string;
  description: string;
  source: DemoSource;
  priority: TaskBoardItemPriority;
  initialStatus: "triage" | "todo";
  labels: string[];
  effort: string;
  /** Present on tasks the Deco agent picks up and completes. */
  pr?: DemoPr;
  sessions?: DemoSession[];
  cms?: DemoCmsFix;
}

export interface DemoTask extends DemoTaskSeed {
  status: TaskBoardItemStatus;
  prStatus?: "open" | "merged";
  published: boolean;
  publishState: "idle" | "publishing" | "published";
}

export const SOURCE_LABEL: Record<DemoSource, string> = {
  ga4: "Google Analytics 4",
  gsc: "Search Console",
  github: "GitHub",
};

const session = (
  startedAgo: string,
  workingStatus: string,
  steps: Array<[string, string]>,
): DemoSession => ({
  startedBy: "valls",
  startedAgo,
  workingStatus,
  steps: steps.map(([text, time]) => ({ text, time })),
});

export const DEMO_TASK_SEEDS: DemoTaskSeed[] = [
  {
    id: "acm-101",
    key: "ACM-101",
    title: "Add meta descriptions to 34 product pages",
    description:
      "Search Console reports 34 product pages with missing meta descriptions, all in the linen and bedding categories. These pages average position 8.2 but a 0.9% CTR, roughly half the site median. Writing descriptions from existing product copy should lift clicks without any ranking change.",
    source: "gsc",
    priority: "high",
    initialStatus: "todo",
    labels: ["seo", "content"],
    effort: "2h",
    pr: {
      number: 482,
      title: "fix: add meta descriptions to product pages",
      branch: "deco/acm-101-meta-descriptions",
      additions: 148,
      deletions: 6,
      summary: [
        "Generates meta descriptions from product copy for 34 PDPs",
        "Adds a description fallback to the PDP head template",
        "Caps descriptions at 155 characters with sentence-safe truncation",
        "Adds a lint check so new products cannot ship without one",
      ],
      files: [
        { path: "src/templates/pdp/head.tsx", additions: 32, deletions: 4 },
        {
          path: "src/lib/seo/meta-description.ts",
          additions: 58,
          deletions: 0,
        },
        { path: "content/products/linen/*.json", additions: 34, deletions: 0 },
        {
          path: "content/products/bedding/*.json",
          additions: 18,
          deletions: 0,
        },
        { path: "scripts/lint-seo.ts", additions: 6, deletions: 2 },
      ],
    },
    sessions: [
      session("4h", "editing product templates", [
        ["Read task and acceptance criteria", "4h"],
        ["Queried Search Console for the 34 affected URLs", "4h"],
        ["Located the PDP head template in the storefront repo", "3h"],
        ["Drafted descriptions from product copy, 155 char cap", "3h"],
        ["Edited 5 files", "3h"],
        ["Ran checks, all passing", "3h"],
        ["Opened PR #482", "3h"],
      ]),
    ],
    cms: {
      fieldLabel: "Meta description",
      fieldValue:
        "Breathable 100% linen shirt in washed indigo. Pre-shrunk, garment-dyed and cut for an easy fit. Free shipping over $80 and 30-day returns.",
      previewNote: "Meta description added",
    },
  },
  {
    id: "acm-102",
    key: "ACM-102",
    title: "Fix duplicate title tags across /collections",
    description:
      'Search Console flags 21 collection pages sharing the title "Shop all | Acme Store". Duplicates split impressions and make results indistinguishable in the SERP. Each collection already has a display name that can feed the title template.',
    source: "gsc",
    priority: "medium",
    initialStatus: "todo",
    labels: ["seo"],
    effort: "1h",
    pr: {
      number: 483,
      title: "fix: unique title tags for collection pages",
      branch: "deco/acm-102-collection-titles",
      additions: 41,
      deletions: 17,
      summary: [
        "Builds collection titles from display name plus category",
        'Removes the hardcoded "Shop all" fallback',
        "Backfills titles for 21 affected collections",
      ],
      files: [
        {
          path: "src/templates/collection/head.tsx",
          additions: 18,
          deletions: 12,
        },
        { path: "src/lib/seo/title.ts", additions: 15, deletions: 3 },
        { path: "content/collections/index.json", additions: 8, deletions: 2 },
      ],
    },
    sessions: [
      session("4h", "rewriting the title template", [
        ["Read task and acceptance criteria", "4h"],
        ["Listed the 21 duplicate titles via Search Console", "4h"],
        ["Traced the fallback to collection/head.tsx", "3h"],
        ["Edited 3 files", "3h"],
        ["Ran checks, all passing", "3h"],
        ["Opened PR #483", "3h"],
      ]),
    ],
    cms: {
      fieldLabel: "Page title",
      fieldValue: "Linen shirts, washed and garment-dyed | Acme Store",
      previewNote: "Unique title tag",
    },
  },
  {
    id: "acm-103",
    key: "ACM-103",
    title: "Compress hero images on home (4.2 MB total)",
    description:
      "GA4 shows home LCP at 3.8s on mobile, and the waterfall points at three hero images totaling 4.2 MB served as PNG. Converting to AVIF with responsive srcset should cut the payload by roughly 85%. Home drives 41% of sessions, so this is the highest-leverage performance fix available.",
    source: "ga4",
    priority: "high",
    initialStatus: "todo",
    labels: ["performance"],
    effort: "2h",
    pr: {
      number: 484,
      title: "perf: compress and lazy-size home hero images",
      branch: "deco/acm-103-hero-images",
      additions: 63,
      deletions: 28,
      summary: [
        "Converts three hero PNGs to AVIF with WebP fallback",
        "Adds responsive srcset with 480/960/1440 widths",
        "Preloads only the first hero image",
        "Payload drops from 4.2 MB to 610 KB",
      ],
      files: [
        { path: "src/sections/home/hero.tsx", additions: 34, deletions: 20 },
        { path: "src/lib/images/srcset.ts", additions: 21, deletions: 4 },
        { path: "static/hero/*", additions: 8, deletions: 4 },
      ],
    },
    sessions: [
      session("3h", "converting hero assets", [
        ["Read task and acceptance criteria", "3h"],
        ["Confirmed LCP element via the GA4 web vitals report", "3h"],
        ["Located hero section and image pipeline", "3h"],
        ["Converted assets and added srcset", "2h"],
        ["Ran checks, all passing", "2h"],
        ["Opened PR #484", "2h"],
      ]),
    ],
    cms: {
      fieldLabel: "Hero image",
      fieldValue: "hero-linen-fall.avif (198 KB, was 1.6 MB)",
      previewNote: "Image compressed",
    },
  },
  {
    id: "acm-104",
    key: "ACM-104",
    title: "Fix 12 indexed URLs returning 404",
    description:
      "Search Console lists 12 indexed URLs now returning 404, mostly retired products still linked from category pages and two old campaign landing pages. They received 3.1k impressions last month. Redirecting to the closest live category preserves that equity.",
    source: "gsc",
    priority: "urgent",
    initialStatus: "todo",
    labels: ["seo"],
    effort: "1h",
    pr: {
      number: 485,
      title: "fix: redirect 12 indexed 404 URLs",
      branch: "deco/acm-104-404-redirects",
      additions: 29,
      deletions: 2,
      summary: [
        "Adds 301 redirects for 10 retired product URLs",
        "Redirects 2 expired campaign pages to /sale",
        "Adds a redirect map test to prevent regressions",
      ],
      files: [
        { path: "config/redirects.json", additions: 14, deletions: 0 },
        { path: "src/middleware/redirects.ts", additions: 9, deletions: 2 },
        {
          path: "src/middleware/redirects.test.ts",
          additions: 6,
          deletions: 0,
        },
      ],
    },
    sessions: [
      session("2h", "mapping redirect targets", [
        ["Read task and acceptance criteria", "2h"],
        ["Pulled the 404 list from Search Console", "2h"],
        ["Matched each URL to the closest live category", "2h"],
        ["Edited 3 files", "1h"],
        ["Ran checks, all passing", "1h"],
        ["Opened PR #485", "1h"],
      ]),
      session("1h", "verifying redirect coverage", [
        ["Re-crawled the 12 URLs against the preview build", "1h"],
        ["Confirmed all return 301 to a live page", "1h"],
        ["Posted verification results on the PR", "1h"],
      ]),
    ],
    cms: {
      fieldLabel: "Redirect target",
      fieldValue: "/products/retired-oxford-shirt -> /collections/shirts",
      previewNote: "Redirect in place",
    },
  },
  {
    id: "acm-105",
    key: "ACM-105",
    title: "Reduce LCP on /products (4.1s on mobile)",
    description:
      "GA4 web vitals put /products LCP at 4.1s on mobile against a 2.5s target. The LCP element is the first product card image, which loads after two render-blocking scripts. Deferring those scripts and preloading the first image row should bring it under target.",
    source: "ga4",
    priority: "high",
    initialStatus: "todo",
    labels: ["performance"],
    effort: "3h",
    pr: {
      number: 486,
      title: "perf: cut LCP on product listing",
      branch: "deco/acm-105-plp-lcp",
      additions: 52,
      deletions: 31,
      summary: [
        "Defers two render-blocking third-party scripts",
        "Preloads above-the-fold product card images",
        "Sets explicit dimensions to stop layout shift",
        "Lab LCP drops from 4.1s to 2.2s on mobile",
      ],
      files: [
        { path: "src/templates/plp/index.tsx", additions: 22, deletions: 15 },
        {
          path: "src/components/product-card.tsx",
          additions: 18,
          deletions: 9,
        },
        { path: "src/lib/scripts/loader.ts", additions: 12, deletions: 7 },
      ],
    },
    sessions: [
      session("2h", "profiling the listing page", [
        ["Read task and acceptance criteria", "2h"],
        ["Reproduced the 4.1s LCP in a mobile trace", "2h"],
        ["Identified two render-blocking scripts", "2h"],
        ["Deferred scripts and preloaded first image row", "1h"],
        ["Ran checks, all passing", "1h"],
        ["Opened PR #486", "1h"],
      ]),
    ],
    cms: {
      fieldLabel: "Script loading",
      fieldValue: "reviews-widget.js and chat.js now load after first paint",
      previewNote: "LCP 2.2s",
    },
  },
  {
    id: "acm-106",
    key: "ACM-106",
    title: "Add alt text to 148 product images",
    description:
      "A crawl of the catalog found 148 product images with empty alt attributes across 52 PDPs. This hurts image search visibility and accessibility. Alt text can be generated from product name, color and material already present in the catalog data.",
    source: "gsc",
    priority: "medium",
    initialStatus: "todo",
    labels: ["seo", "content", "a11y"],
    effort: "2h",
    pr: {
      number: 487,
      title: "fix: generate alt text for product images",
      branch: "deco/acm-106-image-alt-text",
      additions: 74,
      deletions: 11,
      summary: [
        "Derives alt text from product name, color and material",
        "Backfills 148 images across 52 PDPs",
        "Fails the build when a product image ships without alt text",
      ],
      files: [
        {
          path: "src/components/product-gallery.tsx",
          additions: 19,
          deletions: 8,
        },
        { path: "src/lib/catalog/alt-text.ts", additions: 36, deletions: 0 },
        { path: "scripts/lint-images.ts", additions: 12, deletions: 3 },
        { path: "content/products/index.json", additions: 7, deletions: 0 },
      ],
    },
    sessions: [
      session("2h", "backfilling alt attributes", [
        ["Read task and acceptance criteria", "2h"],
        ["Crawled PDPs and listed 148 images missing alt text", "2h"],
        ["Wrote the alt text generator from catalog fields", "1h"],
        ["Edited 4 files", "1h"],
        ["Ran checks, all passing", "1h"],
        ["Opened PR #487", "1h"],
      ]),
    ],
    cms: {
      fieldLabel: "Image alt text",
      fieldValue: "Washed indigo linen shirt, front view on model",
      previewNote: "Alt text added",
    },
  },
  {
    id: "acm-107",
    key: "ACM-107",
    title: "Generate sitemap.xml on build",
    description:
      "The storefront has no sitemap, so new PDPs take days to be discovered. GitHub shows the build pipeline already enumerates all routes for prerendering. Emitting a sitemap from that same route list is a small addition with immediate crawl benefits.",
    source: "github",
    priority: "medium",
    initialStatus: "todo",
    labels: ["seo"],
    effort: "1h",
    pr: {
      number: 488,
      title: "feat: emit sitemap.xml at build time",
      branch: "deco/acm-107-sitemap",
      additions: 88,
      deletions: 0,
      summary: [
        "Generates sitemap.xml from the prerender route list",
        "Includes lastmod from content timestamps",
        "Registers the sitemap in robots.txt",
      ],
      files: [
        { path: "scripts/build-sitemap.ts", additions: 64, deletions: 0 },
        { path: "static/robots.txt", additions: 2, deletions: 0 },
        { path: "package.json", additions: 3, deletions: 0 },
        { path: "scripts/build-sitemap.test.ts", additions: 19, deletions: 0 },
      ],
    },
    sessions: [
      session("1h", "wiring the sitemap build step", [
        ["Read task and acceptance criteria", "1h"],
        ["Found the prerender route list in the build script", "1h"],
        ["Wrote the sitemap generator with lastmod support", "1h"],
        ["Ran checks, all passing", "45m"],
        ["Opened PR #488", "45m"],
      ]),
    ],
    cms: {
      fieldLabel: "Sitemap",
      fieldValue: "https://acme.store/sitemap.xml (1,284 URLs)",
      previewNote: "Sitemap live",
    },
  },
  {
    id: "acm-108",
    key: "ACM-108",
    title: "Fix hreflang pairs for en/pt locales",
    description:
      "Search Console reports 61 pages with hreflang errors: the en pages point to pt alternates, but the pt pages never point back. Without return links Google ignores the whole annotation. The locale map exists in the router config and can drive both directions.",
    source: "gsc",
    priority: "medium",
    initialStatus: "todo",
    labels: ["seo"],
    effort: "2h",
    pr: {
      number: 489,
      title: "fix: emit reciprocal hreflang for en/pt",
      branch: "deco/acm-108-hreflang",
      additions: 45,
      deletions: 19,
      summary: [
        "Emits reciprocal hreflang pairs from the locale map",
        "Adds x-default pointing at the en locale",
        "Covers 61 previously broken pages",
      ],
      files: [
        {
          path: "src/templates/shared/head-links.tsx",
          additions: 27,
          deletions: 14,
        },
        { path: "src/lib/i18n/alternates.ts", additions: 13, deletions: 5 },
        { path: "src/lib/i18n/alternates.test.ts", additions: 5, deletions: 0 },
      ],
    },
    sessions: [
      session("1h", "fixing locale alternates", [
        ["Read task and acceptance criteria", "1h"],
        ["Confirmed missing return links on pt pages", "1h"],
        ["Rewired alternates to emit both directions", "1h"],
        ["Ran checks, all passing", "50m"],
        ["Opened PR #489", "50m"],
      ]),
    ],
    cms: {
      fieldLabel: "Hreflang",
      fieldValue: "en-US <-> pt-BR reciprocal pairs plus x-default",
      previewNote: "Hreflang paired",
    },
  },
  {
    id: "acm-109",
    key: "ACM-109",
    title: "Add structured data (Product) to PDPs",
    description:
      "PDPs ship no Product schema, so listings show without price, availability or review stars. Competitors in the same queries all have rich results. The catalog API already exposes every required field, this is a template-only change.",
    source: "github",
    priority: "high",
    initialStatus: "todo",
    labels: ["seo"],
    effort: "2h",
    pr: {
      number: 490,
      title: "feat: add Product structured data to PDPs",
      branch: "deco/acm-109-product-schema",
      additions: 97,
      deletions: 3,
      summary: [
        "Adds JSON-LD Product schema with offers and aggregateRating",
        "Maps availability from live inventory state",
        "Validates output against the schema.org test suite in CI",
      ],
      files: [
        {
          path: "src/templates/pdp/structured-data.tsx",
          additions: 61,
          deletions: 0,
        },
        { path: "src/templates/pdp/head.tsx", additions: 9, deletions: 3 },
        { path: "src/lib/seo/schema.test.ts", additions: 27, deletions: 0 },
      ],
    },
    sessions: [
      session("1h", "building the JSON-LD template", [
        ["Read task and acceptance criteria", "1h"],
        ["Mapped catalog fields to schema.org Product", "1h"],
        ["Added offers and rating blocks", "55m"],
        ["Validated sample PDPs with the rich results test", "50m"],
        ["Ran checks, all passing", "45m"],
        ["Opened PR #490", "45m"],
      ]),
    ],
    cms: {
      fieldLabel: "Structured data",
      fieldValue: "Product + Offer + AggregateRating JSON-LD",
      previewNote: "Rich result ready",
    },
  },
  {
    id: "acm-110",
    key: "ACM-110",
    title: "Enable text compression on static assets",
    description:
      "The edge config serves JS and CSS uncompressed: 812 KB that would be 214 KB with brotli. GitHub shows the CDN config file was last touched before compression support landed. One config block fixes every page load on the site.",
    source: "github",
    priority: "medium",
    initialStatus: "todo",
    labels: ["performance"],
    effort: "30m",
    pr: {
      number: 491,
      title: "perf: enable brotli on static assets",
      branch: "deco/acm-110-brotli",
      additions: 18,
      deletions: 4,
      summary: [
        "Enables brotli with gzip fallback at the edge",
        "Adds cache-control revalidation for compressed variants",
        "Static payload drops from 812 KB to 214 KB",
      ],
      files: [
        { path: "deploy/edge.config.ts", additions: 12, deletions: 4 },
        { path: "deploy/edge.config.test.ts", additions: 6, deletions: 0 },
      ],
    },
    sessions: [
      session("50m", "updating the edge config", [
        ["Read task and acceptance criteria", "50m"],
        ["Confirmed uncompressed responses via response headers", "50m"],
        ["Enabled brotli with gzip fallback", "45m"],
        ["Ran checks, all passing", "40m"],
        ["Opened PR #491", "40m"],
      ]),
    ],
    cms: {
      fieldLabel: "Compression",
      fieldValue: "brotli enabled, 812 KB -> 214 KB",
      previewNote: "Compression on",
    },
  },
  {
    id: "acm-111",
    key: "ACM-111",
    title: "Broken internal links from blog to retired products",
    description:
      "The blog links to 17 retired product URLs from 9 posts, all returning 404. These posts still rank and pass authority nowhere. Links should point at the replacement products or the parent category.",
    source: "gsc",
    priority: "low",
    initialStatus: "todo",
    labels: ["seo", "content"],
    effort: "1h",
  },
  {
    id: "acm-112",
    key: "ACM-112",
    title: "Simplify size selection on PDPs, 41% drop at variant step",
    description:
      "GA4 funnel analysis shows 41% of mobile users abandon the PDP at the size selection step. Session replays suggest the size grid is below the fold and the out-of-stock states are ambiguous. Moving the selector up and greying out unavailable sizes should recover part of that drop.",
    source: "ga4",
    priority: "high",
    initialStatus: "todo",
    labels: ["cro"],
    effort: "4h",
  },
  {
    id: "acm-113",
    key: "ACM-113",
    title: "Add trust badges near checkout CTA",
    description:
      "Exit surveys cite payment security doubts as the second reason for abandoning checkout. The checkout CTA area has room for accepted payment marks and the returns guarantee. Low effort, commonly a 1-2% conversion lift on cold traffic.",
    source: "ga4",
    priority: "low",
    initialStatus: "todo",
    labels: ["cro"],
    effort: "1h",
  },
  {
    id: "acm-114",
    key: "ACM-114",
    title: "Improve CTR on linen shirts queries (position 6, CTR 1.2%)",
    description:
      "Search Console shows the linen shirts cluster averaging position 6 with a 1.2% CTR, well under the 4% expected at that position. The current snippet is a generic collection title with no price or material angle. A rewritten title and description should close most of the gap.",
    source: "gsc",
    priority: "medium",
    initialStatus: "todo",
    labels: ["seo", "content"],
    effort: "1h",
  },
  {
    id: "acm-115",
    key: "ACM-115",
    title: "Lazy load below-the-fold sections on home",
    description:
      "Home renders 11 sections eagerly, but scroll depth data shows 62% of mobile users never pass section 4. Lazy loading the rest removes about 300 KB of JS from the critical path. The section framework already supports deferred hydration.",
    source: "github",
    priority: "medium",
    initialStatus: "todo",
    labels: ["performance"],
    effort: "2h",
  },
  {
    id: "acm-116",
    key: "ACM-116",
    title: "Cart page exit rate 44%: surface shipping estimate earlier",
    description:
      "GA4 shows a 44% exit rate on the cart page, and the top rage-click target is the shipping calculator hidden behind an accordion. Showing the estimate inline for the default region removes the main friction point before checkout.",
    source: "ga4",
    priority: "high",
    initialStatus: "todo",
    labels: ["cro"],
    effort: "3h",
  },
  {
    id: "acm-117",
    key: "ACM-117",
    title: "Upgrade image CDN loader to serve AVIF",
    description:
      "The image loader pins format to WebP even for browsers that accept AVIF, leaving roughly 25% extra bytes on every image. The CDN has supported AVIF since last quarter. Switching to format negotiation is a one-line loader change plus cache validation.",
    source: "github",
    priority: "low",
    initialStatus: "todo",
    labels: ["performance"],
    effort: "1h",
  },
  {
    id: "acm-118",
    key: "ACM-118",
    title: "Consolidate duplicate /sale and /outlet pages",
    description:
      "Both /sale and /outlet list the same discounted inventory with near-identical copy, and Search Console shows them cannibalizing the same queries. Picking /sale as canonical and 301-ing /outlet consolidates signals into one page.",
    source: "gsc",
    priority: "medium",
    initialStatus: "todo",
    labels: ["seo"],
    effort: "1h",
  },
  {
    id: "acm-119",
    key: "ACM-119",
    title: "Search results page has 0.4% CTR on mobile: rework layout",
    description:
      "On-site search results convert poorly on mobile: 0.4% of result views lead to a PDP visit. Results render as a dense text list with no images. Reusing the product card grid from category pages should make results scannable.",
    source: "ga4",
    priority: "medium",
    initialStatus: "todo",
    labels: ["cro"],
    effort: "4h",
  },
  {
    id: "acm-120",
    key: "ACM-120",
    title: "Remove unused 212 KB legacy analytics bundle",
    description:
      "The bundle report flags a legacy analytics vendor script still shipped on every page despite the migration to GA4 finishing in March. It weighs 212 KB and opens two extra connections. Removing it is pure win with no data loss.",
    source: "github",
    priority: "medium",
    initialStatus: "todo",
    labels: ["performance"],
    effort: "30m",
  },
  {
    id: "acm-121",
    key: "ACM-121",
    title: "Write meta titles for 9 new arrivals collections",
    description:
      'Nine recently created collections launched with placeholder titles like "New collection". They are already indexed and receiving impressions. Proper titles with category and season keywords should be written before the fall campaign starts.',
    source: "gsc",
    priority: "low",
    initialStatus: "todo",
    labels: ["content", "seo"],
    effort: "1h",
  },
  {
    id: "acm-122",
    key: "ACM-122",
    title: "Promo banner hides add to cart on small screens",
    description:
      "On viewports under 380px the sticky promo banner overlaps the add to cart button on PDPs. GA4 shows add-to-cart rate on small devices at half the rate of larger phones since the banner shipped. Either collapse the banner on scroll or shrink it on small screens.",
    source: "ga4",
    priority: "urgent",
    initialStatus: "todo",
    labels: ["cro"],
    effort: "1h",
  },
  {
    id: "acm-123",
    key: "ACM-123",
    title: "Investigate traffic drop on /collections/bedding (-31% WoW)",
    description:
      "Bedding collection sessions fell 31% week over week with no corresponding ranking change in Search Console. The drop starts exactly when the collection was reorganized. Needs investigation before it can be scoped as a fix.",
    source: "ga4",
    priority: "medium",
    initialStatus: "triage",
    labels: ["seo"],
    effort: "2h",
  },
  {
    id: "acm-124",
    key: "ACM-124",
    title: "Review thin content warning on tag pages",
    description:
      "Search Console surfaced a soft warning about thin content on auto-generated tag pages. There are 340 tag pages, most listing one or two products. Options are noindexing the long tail or merging tags, which needs a product decision first.",
    source: "gsc",
    priority: "high",
    initialStatus: "triage",
    labels: ["seo"],
    effort: "3h",
  },
  {
    id: "acm-125",
    key: "ACM-125",
    title: "Flaky checkout e2e test failing 1 in 5 runs",
    description:
      "The checkout happy-path e2e fails roughly once every five CI runs on a payment iframe timeout. It blocks unrelated merges and the team has started rerunning instead of investigating. Needs a root cause before trust erodes further.",
    source: "github",
    priority: "medium",
    initialStatus: "triage",
    labels: ["engineering"],
    effort: "3h",
  },
  {
    id: "acm-126",
    key: "ACM-126",
    title: "Validate GA4 purchase event double-firing on order confirmation",
    description:
      "Revenue in GA4 runs 8-9% above the order management system every week. A tag audit suggests the purchase event fires again when users refresh the confirmation page. Needs confirmation and a deduplication key before any funnel numbers can be trusted.",
    source: "ga4",
    priority: "high",
    initialStatus: "triage",
    labels: ["analytics"],
    effort: "2h",
  },
  {
    id: "acm-127",
    key: "ACM-127",
    title: "Decide canonical strategy for color variant URLs",
    description:
      "Each color variant currently gets its own indexable URL, multiplying near-duplicate PDPs. Search Console shows Google picking inconsistent canonicals across the catalog. Consolidating to a primary variant or self-canonical per color is a strategy call that needs input.",
    source: "gsc",
    priority: "medium",
    initialStatus: "triage",
    labels: ["seo"],
    effort: "2h",
  },
  {
    id: "acm-128",
    key: "ACM-128",
    title: "Audit dependency alerts: 3 moderate advisories",
    description:
      "GitHub raised three moderate security advisories on the storefront repo, all in transitive dependencies of the image pipeline. None are exploitable in the current setup but two have straightforward upgrades. Worth batching into one maintenance pass.",
    source: "github",
    priority: "low",
    initialStatus: "triage",
    labels: ["engineering"],
    effort: "1h",
  },
];
