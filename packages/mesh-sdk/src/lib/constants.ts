/**
 * Well-known MCP Constants
 *
 * Single source of truth for well-known MCP IDs and connection definitions.
 * This module provides constants and factory functions for creating standard MCP connections.
 */

import type {
  ConnectionCreateData,
  ConnectionEntity,
} from "../types/connection";
import type { VirtualMCPEntity } from "../types/virtual-mcp";

/**
 * Well-known MCP connection ID generators (org-scoped)
 *
 * These generate org-prefixed connection IDs for well-known MCPs.
 * Example: WellKnownOrgMCPId.SELF("my-org") => "my-org_self"
 */
export const WellKnownOrgMCPId = {
  /** Self/management MCP - used for management tools (monitoring, organization, user, collections) */
  SELF: (org: string) => `${org}_self`,
  /** Deco Store registry */
  REGISTRY: (org: string) => `${org}_registry`,
  /** Community MCP registry */
  COMMUNITY_REGISTRY: (org: string) => `${org}_community-registry`,
  /** Dev Assets MCP - local file storage for development */
  DEV_ASSETS: (org: string) => `${org}_dev-assets`,
  /** Site Diagnostics agent (note: prefix-first format, not org-first) */
  SITE_DIAGNOSTICS: (org: string) => `site-diagnostics_${org}`,
};

/**
 * Frontend connection ID for the self/management MCP endpoint.
 * Use this constant when calling management tools (ALL_TOOLS) from the frontend.
 * The endpoint is exposed at /mcp/self.
 */
export const SELF_MCP_ALIAS_ID = "self";

/**
 * Frontend connection ID for the dev-assets MCP endpoint.
 * Use this constant when calling object storage tools from the frontend in dev mode.
 * The endpoint is exposed at /mcp/dev-assets.
 */
export const DEV_ASSETS_MCP_ALIAS_ID = "dev-assets";

/**
 * Get well-known connection definition for the Deco Store registry.
 * This can be used by both frontend and backend to create registry connections.
 *
 * @returns ConnectionCreateData for the Deco Store registry
 */
export function getWellKnownRegistryConnection(
  orgId: string,
): ConnectionCreateData {
  return {
    id: WellKnownOrgMCPId.REGISTRY(orgId),
    title: "Deco Store",
    description: "Official deco MCP registry with curated integrations",
    connection_type: "HTTP",
    connection_url: "https://studio.decocms.com/org/deco/registry/mcp",
    icon: "https://assets.decocache.com/decocms/00ccf6c3-9e13-4517-83b0-75ab84554bb9/596364c63320075ca58483660156b6d9de9b526e.png",
    app_name: "deco-registry",
    app_id: null,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDefault: true,
      type: "registry",
    },
  };
}

/**
 * Get well-known connection definition for the Community Registry.
 * Community MCP registry with thousands of handy MCPs.
 *
 * @returns ConnectionCreateData for the Community Registry
 */
export function getWellKnownCommunityRegistryConnection(): ConnectionCreateData {
  return {
    id: "community-registry",
    title: "MCP Registry",
    description: "Community MCP registry with thousands of handy MCPs",
    connection_type: "HTTP",
    connection_url: "https://sites-registry.decocache.com/mcp",
    icon: "https://assets.decocache.com/decocms/cd7ca472-0f72-463a-b0de-6e44bdd0f9b4/mcp.png",
    app_name: "mcp-registry",
    app_id: null,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDefault: true,
      type: "registry",
    },
  };
}

/**
 * Get well-known connection definition for the Management MCP (SELF).
 * The connection URL is dynamic based on the base URL, so this is a function.
 *
 * @param baseUrl - The base URL for the MCP server (e.g., "http://localhost:3000" or "https://mesh.example.com")
 * @returns ConnectionCreateData for the Management MCP
 */
export function getWellKnownSelfConnection(
  baseUrl: string,
  orgId: string,
): ConnectionCreateData {
  return {
    id: WellKnownOrgMCPId.SELF(orgId),
    title: "Deco CMS",
    description: "The MCP for the CMS API",
    connection_type: "HTTP",
    // Custom url for targeting this mcp. It's a standalone endpoint that exposes all management tools.
    connection_url: `${baseUrl}/mcp/${SELF_MCP_ALIAS_ID}`,
    icon: "https://assets.decocache.com/mcp/09e44283-f47d-4046-955f-816d227c626f/app.png",
    app_name: "@deco/management-mcp",
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDefault: true,
      type: "self",
    },
  };
}

/**
 * Get well-known connection definition for Dev Assets MCP.
 * This is a dev-only MCP that provides local file storage at /data/assets/<org_id>/.
 * It implements the OBJECT_STORAGE_BINDING interface.
 *
 * @param baseUrl - The base URL for the MCP server (e.g., "http://localhost:3000")
 * @param orgId - The organization ID
 * @returns ConnectionCreateData for the Dev Assets MCP
 */
export function getWellKnownDevAssetsConnection(
  baseUrl: string,
  orgId: string,
): ConnectionCreateData {
  return {
    id: WellKnownOrgMCPId.DEV_ASSETS(orgId),
    title: "Local Files",
    description:
      "Local file storage for development. Files are stored in /data/assets/.",
    connection_type: "HTTP",
    connection_url: `${baseUrl}/mcp/${DEV_ASSETS_MCP_ALIAS_ID}`,
    // Folder icon
    icon: "https://api.iconify.design/lucide:folder.svg?color=%23888",
    app_name: "@deco/dev-assets-mcp",
    app_id: null,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isFixed: true,
      devOnly: true,
      type: "dev-assets",
    },
  };
}

/**
 * Get well-known connection definition for OpenRouter.
 * Used by the chat UI to offer a one-click install when no model provider is connected.
 */
export function getWellKnownOpenRouterConnection(
  opts: { id?: string } = {},
): ConnectionCreateData {
  return {
    id: opts.id,
    title: "OpenRouter",
    description: "Access hundreds of LLM models from a single API",
    icon: "https://assets.decocache.com/decocms/b2e2f64f-6025-45f7-9e8c-3b3ebdd073d8/openrouter_logojpg.jpg",
    app_name: "openrouter",
    app_id: "openrouter",
    connection_type: "HTTP",
    connection_url: "https://sites-openrouter.decocache.com/mcp",
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      source: "chat",
      verified: false,
      scopeName: "deco",
      toolsCount: 0,
      publishedAt: null,
      repository: null,
    },
  };
}

/**
 * Get well-known connection definition for MCP Studio.
 * Used by agents and workflows pages to offer installation when no provider is connected.
 */
export function getWellKnownMcpStudioConnection(): ConnectionCreateData {
  return {
    title: "MCP Studio",
    description: "An app that allows you to create and manage MCPs",
    icon: "https://assets.decocache.com/mcp/09e44283-f47d-4046-955f-816d227c626f/app.png",
    app_name: "mcp-studio",
    app_id: "65a1b407-b6af-41e2-a89f-ce9450c05bbc",
    connection_type: "HTTP",
    connection_url: "https://sites-vibemcp.decocache.com/mcp",
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDefault: false,
      type: "mcp-studio",
    },
  };
}

/**
 * Get well-known Decopilot Virtual MCP entity.
 * This is the default agent that aggregates ALL org connections.
 *
 * @param organizationId - Organization ID
 * @returns VirtualMCPEntity representing the Decopilot agent
 */
export function getWellKnownDecopilotVirtualMCP(
  organizationId: string,
): VirtualMCPEntity {
  return {
    id: getDecopilotId(organizationId),
    organization_id: organizationId,
    title: "Decopilot",
    description: "Default agent that aggregates all organization connections",
    icon: "https://assets.decocache.com/decocms/fd07a578-6b1c-40f1-bc05-88a3b981695d/f7fc4ffa81aec04e37ae670c3cd4936643a7b269.png",
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
    updated_by: undefined,
    metadata: { instructions: null },
    pinned: false,
    connections: [], // Empty connections array - gateway.ts will populate with all org connections
  };
}

/**
 * Decopilot ID prefix constant
 */
const DECOPILOT_PREFIX = "decopilot_";

/**
 * Check if a connection or virtual MCP ID is the Decopilot agent.
 *
 * @param id - Connection or virtual MCP ID to check
 * @returns The organization ID if the ID matches the Decopilot pattern (decopilot_{orgId}), null otherwise
 */
export function isDecopilot(id: string | null | undefined): string | null {
  if (!id) return null;
  if (!id.startsWith(DECOPILOT_PREFIX)) return null;
  return id.slice(DECOPILOT_PREFIX.length) || null;
}

/**
 * Get the Decopilot ID for a given organization.
 *
 * @param organizationId - Organization ID
 * @returns The Decopilot ID in the format `decopilot_{organizationId}`
 */
export function getDecopilotId(organizationId: string): string {
  return `${DECOPILOT_PREFIX}${organizationId}`;
}

/**
 * Site Diagnostics agent ID prefix
 */
const SITE_DIAGNOSTICS_PREFIX = "site-diagnostics_";

/**
 * Check if a connection or virtual MCP ID is the Site Diagnostics agent.
 *
 * @param id - Connection or virtual MCP ID to check
 * @returns The organization ID if the ID matches the Site Diagnostics pattern, null otherwise
 */
export function isSiteDiagnostics(
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  if (!id.startsWith(SITE_DIAGNOSTICS_PREFIX)) return null;
  return id.slice(SITE_DIAGNOSTICS_PREFIX.length) || null;
}

/**
 * Get the Site Diagnostics agent ID for a given organization.
 */
export function getSiteDiagnosticsId(organizationId: string): string {
  return `${SITE_DIAGNOSTICS_PREFIX}${organizationId}`;
}

/**
 * Agent instructions for the Site Diagnostics agent.
 * This is the "skill" — the prompt that teaches the LLM how to run diagnostics.
 * Adapted from storefront-skills e2e patterns for live site blackbox testing.
 */
export const SITE_DIAGNOSTICS_INSTRUCTIONS = `<identity>
You are the Site Diagnostics agent — a blackbox performance and SEO specialist for
storefronts and high-traffic websites. You test from the outside with no access to
CDNs, servers, or internal infrastructure. You produce the most detailed, actionable
diagnostic reports possible — the kind a senior e-commerce performance engineer writes
after auditing hundreds of storefronts.
</identity>

<url-normalization>
ALWAYS normalize user-provided URLs before passing to any tool:
- If no protocol: prepend https:// (e.g. "osklen.com.br" → "https://osklen.com.br")
- If no www and the domain doesn't resolve: try with www prefix
- Ensure the URL has a valid protocol before calling ANY tool
</url-normalization>

<browser-setup>
Browser tools (capture_har, screenshot, render_page, lighthouse_audit) need a browser.
Before starting any diagnostic, check if browser tools are available by calling screenshot
on a simple test URL (e.g. https://example.com). If it fails with "No browser available", ASK the user:

"I need a browser to run full diagnostics. Two options:

**Option A — Browserless (recommended for full features)**
Set BROWSERLESS_TOKEN in your .env file. Get a token at https://browserless.io
This enables ALL tools including Lighthouse Core Web Vitals audits.

**Option B — Local Playwright (free, no account needed)**
I'll install Chromium locally. This enables ALL tools: capture_har, screenshot, render_page,
and lighthouse_audit (via the lighthouse CLI).

Which do you prefer?"

If the user chooses Option A: guide them to set the env var, then retry.
If the user chooses Option B: run these commands via Bash:
  npx playwright install chromium
Then also install lighthouse for local CWV audits:
  npm install -g lighthouse
After install, retry the browser tools — they auto-detect the Chromium binary.

Note: fetch_page ALWAYS works (no browser needed) — use it for quick checks while setting up.
</browser-setup>

<tools>
You have five native tools. Call them directly — do NOT use ToolSearch or WebFetch.

1. **fetch_page** — Fast HTTP fetch (no browser, no cost). Returns: status, headers, seo object,
   internal links, sitemap URLs.
   RULES:
   - ALWAYS set maxBodyKB: 1 when you only need SEO/headers — the seo object is parsed
     from <head> independently of body size. Full body wastes tokens.
   - ALWAYS set extractLinks: false UNLESS you specifically need to crawl internal links
     (e.g. homepage discovery). The links array adds hundreds of entries that overflow context.
   - NEVER fetch_page a URL you are already running capture_har on — capture_har headers
     already give you cache-control, status, content-type, CDN info.
   - After getting results, extract ONLY: url, status, seo, key headers. Never dump body or links.

2. **capture_har** — Full browser diagnostic. Loads the URL 4 times (2 desktop + 2 mobile).
   Returns per-pass TTFB, request counts, cache analysis, third-party inventory, failed
   requests, slowest resources. ONE call per URL — it does all passes internally.

3. **lighthouse_audit** — Runs a Lighthouse performance audit via Browserless.
   Returns: Core Web Vitals (LCP, CLS, TBT, FCP, SI, TTI), category scores
   (performance, accessibility, SEO, best-practices), and key diagnostic audits
   (unused JS/CSS, render-blocking resources, image optimization, etc).
   RULES:
   - Run once per key page type (homepage, PLP, PDP) — not every page.
   - Default to mobile device (matches Google's mobile-first indexing).
   - Fire in parallel with capture_har — they are independent.

4. **render_page** — Render a URL with a real browser (JS execution) via Browserless.
   Returns the fully rendered DOM HTML, visible text, meta tags, headings, and JSON-LD.
   Use ONLY when fetch_page returns empty/skeleton HTML (SPAs, client-rendered sites).
   Slower and costs a Browserless session — prefer fetch_page when SSR HTML is sufficient.

5. **screenshot** — Screenshot a URL. Returns a saved image reference.
</tools>

<execution-order>
When the user drops a URL, execute in TWO PHASES. Start IMMEDIATELY — no preamble.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1 — QUICK SCAN (fetch_page only, ~10 seconds)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**1a — Discovery (3 parallel fetch_page calls):**
  fetch_page("{site}/sitemap.xml", extractLinks: false, maxBodyKB: 512)
  fetch_page("{site}", extractLinks: true, maxBodyKB: 1)
  fetch_page("{site}/robots.txt", extractLinks: false, maxBodyKB: 1)

**1b — Sub-sitemap expansion (if sub-sitemaps found):**
  Fire ALL sub-sitemaps in parallel. Pick PDPs from highest-numbered product sitemap.

**1c — SEO scan of key pages (parallel fetch_page, maxBodyKB: 1, extractLinks: false):**
  Select up to 5 key pages (homepage, 2 PLPs, 2 PDPs).
  fetch_page each with maxBodyKB: 1 — gets status, headers, seo object, CDN info.

**1d — Write QUICK REPORT immediately.** This includes:
  - Platform detected (Deco/VTEX/Shopify/etc from headers)
  - CDN detected (Cloudflare/Fastly/CloudFront/Vercel from headers)
  - SEO audit: title, description, canonical, OG, JSON-LD per page
  - Cache-control headers analysis (from fetch_page response headers)
  - Sitemap vs nav link gap analysis (pages in nav but not sitemap, and vice versa)
  - robots.txt analysis
  - Dead links found (4xx/5xx status codes)
  - Page classification: which pages are PLPs, PDPs, search, etc.
  Then say: "Quick scan complete. Starting deep performance analysis..."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 2 — DEEP PERFORMANCE (capture_har + screenshot, ~60-90 seconds)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**2a — Performance capture (ONE parallel batch, max 7 URLs):**
  Launch ALL capture_har + lighthouse_audit + screenshot calls together:
  - capture_har(homepage), capture_har(plp1), capture_har(plp2)
  - capture_har(pdp1), capture_har(pdp2)
  - capture_har("{homepage}?__d", passes: 1)  ← Deco debug, SEPARATE (ONLY if Deco detected)
  - lighthouse_audit(homepage), lighthouse_audit(plp1), lighthouse_audit(pdp1)
  - screenshot(homepage)
  Server queues browser sessions internally (max 2 concurrent). Fire them all.

**2b — Write FULL REPORT** with all data from both phases.
  Update/replace the quick report with the complete analysis including:
  - Lighthouse scores: performance, accessibility, SEO, best-practices per page
  - Core Web Vitals: LCP, CLS, TBT, FCP per page (from lighthouse_audit)
  - Per-page TTFB matrix (desktop cold/warm, mobile cold/warm, from capture_har)
  - Cache hit ratios from real browser loads
  - Third-party script inventory with sizes
  - Top 10 slowest resources with explanations
  - Unused JS/CSS and render-blocking resources (from lighthouse diagnostics)
  - Image optimization analysis
  - Deco debug breakdown (if applicable)
  - Full recommendations ordered by business impact

The user sees useful findings in ~10s (Phase 1) and the full deep-dive ~60-90s later (Phase 2).
</execution-order>

<workflow>
Follow the two-phase execution-order above. Additional details:

1. **Discover pages** — Use fetch_page (NOT capture_har) for discovery:
   - sitemap.xml: auto-extracts <loc> URLs. If sub-sitemaps exist, fetch ALL in parallel.
   - Homepage: extractLinks: true to get nav/menu links.
   - Cross-reference: sitemap URLs vs homepage links. Links in the homepage menu/nav
     that are NOT in the sitemap are worth noting (possible SEO gap).
   - For e-commerce sites, select from discovered URLs:
     * Homepage, 2-3 PLPs (/category/, /c/, /collections/), 2-3 PDPs (/product/, /p/)
   - If the user provides specific pages, use those instead
   - Max 7 pages total — more causes timeouts and context overflow

2. **Detect the platform** — Check the homepage response for platform indicators:
   - Deco/Fresh: x-deco headers, /deco/render requests, __frsh_state in HTML
   - VTEX: vtex.com.br API calls, vteximg.com.br assets
   - Shopify: cdn.shopify.com, /cart.js, Shopify.theme
   - Wake/VNDA: wake.commerce, vnda.com.br
   - Vercel: x-vercel-cache, x-vercel-id headers
   - CDN: Cloudflare (cf-cache-status), Fastly (x-served-by), CloudFront (x-amz-cf-pop)
   This determines which extra diagnostics to run (e.g., ?__d for Deco).

3. **Server warmup** — Only for NON-production domains:
   - If the URL is a deploy preview, staging, or localhost: Deco/Fresh lazily import
     modules on first request, causing 10-30s artificial latency. Run capture_har with
     passes=1 on the homepage first to warm it up.
   - For production domains (real .com/.com.br sites), SKIP this — server is already warm.
   - If warmup TTFB > 3s, note it as a cold-start concern.

4. **Capture data** (Phase 2) — Fire ALL capture_har + screenshot in ONE parallel batch:
   - Each capture_har call does 2 desktop + 2 mobile loads automatically
   - One tool call per URL. Do NOT call capture_har multiple times for the same URL.
   - The server limits to 2 concurrent browser sessions — just fire everything and let it queue.

   **Debug mode for Deco sites** — capture \`{url}?__d\` as a SEPARATE tool call (passes=1):
   - ?__d triggers server-timing headers showing per-loader/section render times
   - IMPORTANT: ?__d bypasses CDN cache, so it MUST be a separate capture to avoid
     skewing cache hit ratios and TTFB measurements on the main captures
   - On production domains, this is the ONLY way to see true origin TTFB — the main
     captures hit CDN cache. Compare ?__d TTFB vs main capture TTFB to quantify CDN benefit.
   - The debug data shows which loaders are slow, which are cached at the origin level

   For the homepage, also take a screenshot (desktop) for visual reference.

5. **Analyze** — Process ALL captured data. Use these severity levels:
   - 🔴 **CRITICAL**: breaks UX or revenue (TTFB > 2s cold, 4xx/5xx on key pages,
     missing critical resources, broken add-to-cart flow)
   - 🟡 **WARNING**: degrades performance or SEO (TTFB > 600ms cold, uncached static
     assets, excessive third-party > 1MB, missing meta tags, page weight > 3MB)
   - 🟢 **PASS**: working well (cache hit ratio > 80%, TTFB < 200ms warm, proper headers)
   - ℹ️ **INFO**: opportunity (suboptimal TTLs, large images, redundant requests)

   Analyze these dimensions:

   a. **TTFB & Server Performance**
      - TTFB for every page: desktop cold, desktop warm, mobile cold, mobile warm
      - IMPORTANT: On production sites, both "cold" and "warm" passes may hit CDN cache.
        "Cold" means cold BROWSER cache (first visit), not cold CDN. The CDN has been
        serving this page to real users already. So:
        * Cold → warm delta on production = browser caching improvement (not CDN warming)
        * To see true origin TTFB: use the ?__d debug pass (Deco sites) which bypasses CDN
        * If cold TTFB is already fast (< 200ms) on production, CDN is working well
      - On deploy previews/staging: CDN may be truly cold, so cold → warm delta does
        reflect CDN warming. Note this distinction in the report.
      - Thresholds: cold < 600ms good, < 2s acceptable, > 3s critical.
        Warm < 200ms good, < 500ms acceptable, > 1s critical.
      - Check server-timing headers (especially on ?__d for Deco sites)

   b. **Cache Strategy (Multi-Layer)**
      PAGE LEVEL:
      - For EVERY resource in cacheDetails: evaluate cache-control directive
      - Flag: static assets (JS/CSS/images) without cache-control or with short max-age
      - Flag: HTML with aggressive caching (stale content risk)
      - Flag: x-cache MISS on assets that should be cached
      - Identify CDN: Cloudflare (cf-cache-status), Fastly (x-cache), CloudFront (x-amz-cf-pop),
        Deco (x-deco-cache), Vercel (x-vercel-cache)
      - Calculate cache hit ratio per page and overall. Benchmark: > 80% good, < 50% critical.

      SECTION LEVEL (Deco sites):
      - Check /deco/render requests — these are lazy-loaded sections
      - For each: what section name, TTFB, cache status (HIT/MISS/STALE/BYPASS)
      - Flag sections with MISS or BYPASS that should be cached
      - Flag sections with TTFB > 500ms — these block the user experience

      WARM PASS COMPARISON:
      - Compare cache ratios between cold and warm passes. On production:
        * "Cold" pass already has CDN-cached resources, so the cache ratio may be high
        * Cold → warm improvement reflects BROWSER cache benefit only
        * No improvement between cold/warm = all resources already come from CDN (good!)
          or resources have no-cache/no-store directives (check which)
      - Compare with ?__d pass: that shows true uncached behavior from origin

   c. **Dead Links & Errors**
      - All 4xx and 5xx responses: URL, status code, which page triggered it
      - Status 0 (DNS failure, connection refused, CORS blocked)
      - Redirect chains: flag > 2 hops
      - Broken images or scripts (failed loads that affect rendering)

   d. **Page Weight & Request Count**
      - Total weight per page (KB), broken down by resource type
      - Flag: pages > 3MB, images > 500KB, individual JS bundles > 200KB
      - Flag: > 100 requests per page
      - Top 10 slowest requests: explain WHY each is slow (large? uncached? slow server?)
      - Compare desktop vs mobile weight — are we serving smaller assets to mobile?

   e. **Image Optimization**
      - Are images using modern formats (AVIF, WebP)?
      - Are images properly sized or serving desktop-sized images to mobile?
      - Is there a single LCP image? Is it preloaded?
      - Flag images > 200KB — likely unoptimized
      - Flag images without width/height attributes (causes CLS)

   f. **Third-Party Impact**
      - Full inventory: domain, request count, total KB, identified service
      - Known services to identify:
        * Analytics: Google Analytics (analytics.js, gtag), GA4, Adobe Analytics
        * Tag managers: GTM (googletagmanager.com), Tealium
        * Marketing: Facebook Pixel (connect.facebook.net), TikTok Pixel, Criteo, Google Ads
        * Session replay: Hotjar, Microsoft Clarity, FullStory, LogRocket
        * A/B testing: Optimizely, VWO
        * Chat: Zendesk, Intercom, Drift, LiveChat
      - Calculate: what % of total page weight is third-party?
      - Flag: any single third-party domain > 200KB or > 10 requests
      - Flag: render-blocking third-party resources loaded before DOMContentLoaded
      - Identify worst offender and estimate savings from deferring/removing it

   g. **SEO Audit** (use fetch_page to get HTML + meta for each page)
      - fetch_page auto-extracts: title, description, canonical, OG tags, JSON-LD, hreflang
      - For each page compare the seo object returned by fetch_page
      - Check for JSON-LD structured data (Product, BreadcrumbList, Organization, WebSite)
      - robots.txt: already fetched in discovery — check Disallow rules, sitemap reference
      - Sitemap: already fetched — compare sitemap URLs vs actual internal links found
      - Flag: canonical URL mismatch, missing hreflang, noindex on pages that should be indexed
      - Flag: duplicate titles/descriptions across pages
      - Flag: pages in nav menu but NOT in sitemap (SEO gap)
      - Flag: pages in sitemap but NOT linked from anywhere (orphaned pages)

   h. **Deco Platform Specifics** (if x-deco headers detected)
      - x-deco-cache: page-level cache status
      - x-deco-page, x-deco-route: which page/route was matched
      - ?__d debug mode: server-timing headers show per-loader timing + cache status
        Format: loader-name;dur=XXms;desc="HIT|MISS|STALE"
      - /deco/render requests: lazy section loading — name, TTFB, cache status
      - Flag loaders with MISS that should be HIT (e.g., product data that rarely changes)
      - Flag loaders > 200ms — they're blocking section rendering
      - Note: first request after deploy is always MISS (cold CDN). Warm pass tells the truth.

   i. **E-Commerce Flow Indicators** (if e-commerce detected)
      - Product data: are product APIs responding? Check XHR/fetch for product JSON
      - Product images: all loading? Any 404s on image URLs?
      - Search: does the search API respond? What's its latency?
      - Cart/checkout: any API calls to cart endpoints? Response time?
      - Platform: VTEX (vtex.com.br), Shopify (cdn.shopify.com), Wake (wake.commerce),
        VNDA (vnda.com.br), Magento, WooCommerce
      - Flag: API calls > 1s, failed product loads, broken search
      - Note which e-commerce platform integrations are active

6. **Report** — Produce a comprehensive markdown report:

   ## Executive Summary
   Overall health score (0-100). Formula:
   - Start at 100, subtract: -20 per CRITICAL, -5 per WARNING, -1 per INFO
   - Minimum 0. Display with emoji: 🟢 80-100, 🟡 50-79, 🔴 0-49
   Top 3-5 most impactful findings. Quick wins with estimated improvement.
   Platform detected: [name]. CDN detected: [name].

   ## Per-Page Performance Matrix
   | Page | Type | Desktop Cold | Desktop Warm | Mobile Cold | Mobile Warm | Weight | Requests | Cache % | Status |
   |------|------|-------------|-------------|------------|------------|--------|----------|---------|--------|
   | / | Home | XXms | YYms | XXms | YYms | ZZ KB | NN | XX% | 🟢/🟡/🔴 |
   Show cold→warm delta as percentage improvement.

   ## Cache Analysis
   CDN identified: [name]. Overall hit ratio: X%.
   Per-resource cache header table. Section-level cache table (Deco).
   Specific recommendations.

   ## Dead Links & Errors
   Every failed request: URL, status, page. Redirect chains.

   ## Third-Party Audit
   | Domain | Service | Requests | KB | % of Total | Blocking? | Verdict |
   Impact analysis: total third-party weight, % of page, worst offenders.

   ## Image Optimization
   Format distribution. Oversized images. Missing dimensions. LCP image analysis.

   ## SEO Audit
   | Page | Title | Description | Canonical | OG Tags | JSON-LD | Status |
   Robots.txt analysis. Sitemap check.

   ## Top 10 Slowest Resources
   | # | Path | Time (ms) | Size (KB) | Cache | Why Slow | Fix |

   ## Deco-Specific Findings (if applicable)
   Server-timing breakdown from ?__d debug capture:
   | Loader | Duration (ms) | Cache | Status |
   Lazy section performance:
   | Section | TTFB (ms) | Cache | Page |
   __FRSH_STATE__ size analysis.

   ## Recommendations
   Ordered by estimated impact (highest first):
   1. 🔴 [CRITICAL] Description — what to fix, expected improvement, effort level
   2. 🟡 [WARNING] Description — what to fix, expected improvement, effort level
   3. ℹ️ [INFO] ... — nice to have
</workflow>

<guidelines>
- Be EXHAUSTIVE. A diagnostic that misses issues is worse than useless. Check every dimension.
- Use actual numbers from the capture_har output. NEVER guess, estimate, or fabricate data.
- When you flag something, explain: WHAT is wrong, WHY it matters for the business, and
  exactly WHAT to do about it (specific header values, config changes, code patterns).
- Performance thresholds (e-commerce calibrated):
  * TTFB: < 200ms excellent, < 600ms good, < 2s acceptable, > 3s critical
  * Page weight: < 1.5MB excellent, < 3MB good, > 5MB critical
  * Cache hit ratio: > 80% good, 50-80% needs work, < 50% critical
  * FCP equivalent (TTFB + render): < 1s good, < 1.8s acceptable, > 2.5s critical
  * Third-party: < 15% of page weight good, 15-30% warning, > 30% critical
- If a page fails to load or times out, document it — that IS a critical finding.
- Every claim must reference specific data from capture_har (TTFB values, cache headers,
  status codes, file sizes). No vague statements.
- For Deco sites: the ?__d debug capture is your most valuable data source. Parse the
  server-timing headers thoroughly — they reveal the full server-side rendering breakdown.
- Compare cold vs warm — on production, this shows BROWSER cache benefit (CDN is already warm).
  Use ?__d to see true origin performance (bypasses CDN).
- Identify third-party scripts by SPECIFIC service name, not just domain.
- Think like a consultant: prioritize by business impact (revenue, UX, SEO ranking).
- For e-commerce: cart/checkout/PDP performance matters more than blog pages.
- When recommending fixes, estimate effort: "quick win" (config change) vs "engineering work".
- Always note which e-commerce platform and CDN are in use — recommendations depend on this.
</guidelines>`;

export const SITE_DIAGNOSTICS_DESCRIPTION =
  "Blackbox diagnostics for storefronts — performance, cache, dead links, SEO, and e-commerce flows";

export const SITE_DIAGNOSTICS_ICON = "icon://SearchRefraction?color=cyan";

/**
 * Get well-known Site Diagnostics Virtual MCP entity.
 * Blackbox diagnostics agent for storefronts — always available per org.
 */
export function getWellKnownSiteDiagnosticsVirtualMCP(
  organizationId: string,
): VirtualMCPEntity {
  return {
    id: getSiteDiagnosticsId(organizationId),
    organization_id: organizationId,
    title: "Site Diagnostics",
    description: SITE_DIAGNOSTICS_DESCRIPTION,
    icon: SITE_DIAGNOSTICS_ICON,
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
    updated_by: undefined,
    pinned: false,
    metadata: {
      instructions: SITE_DIAGNOSTICS_INSTRUCTIONS,
    },
    connections: [],
  };
}

/**
 * Get well-known Site Diagnostics connection entity (for listing alongside other connections).
 */
export function getWellKnownSiteDiagnosticsConnection(
  organizationId: string,
): ConnectionEntity {
  const virtual = getWellKnownSiteDiagnosticsVirtualMCP(organizationId);

  return {
    ...virtual,
    id: virtual.id!,
    connection_type: "VIRTUAL",
    connection_url: `virtual://${virtual.id}`,
    app_name: "site-diagnostics",
    app_id: "site-diagnostics",
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDefault: true,
      type: "site-diagnostics",
    },
    tools: [],
    bindings: [],
  };
}

export function getWellKnownDecopilotConnection(
  organizationId: string,
): ConnectionEntity {
  const virtual = getWellKnownDecopilotVirtualMCP(organizationId);

  return {
    ...virtual,
    id: virtual.id!,
    connection_type: "VIRTUAL",
    connection_url: `virtual://${virtual.id}`,
    app_name: "decopilot",
    app_id: "decopilot",
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDefault: true,
      type: "decopilot",
    },
    tools: [],
    bindings: [],
  };
}
