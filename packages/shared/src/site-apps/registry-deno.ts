import type { SiteAppRegistryEntry } from "./types";

/**
 * Installable apps for a Deno (Fresh) deco site, from
 * https://github.com/deco-cx/apps.
 *
 * Ported from the catalogue the legacy deco.cx admin read out of Supabase,
 * minus `records` and minus the agent/infra apps that a storefront never
 * installs (`ai-assistants`, `brand-assistant`, `implementation`, `sourei`,
 * `workflows`, `crux`, `htmx`). Not every directory in that repository is an
 * app, which is why this is a list and not a directory scan.
 *
 * No dependency to add on install: a Deno site's `deno.json` already aliases
 * `apps/` to the whole repository on the CDN.
 */
export const DENO_SITE_APPS: readonly SiteAppRegistryEntry[] = [
  {
    blockKey: "deco-vtex",
    vendor: "deco",
    app: "vtex",
    title: "VTEX",
    description:
      "Loaders, actions and workflows for adding VTEX Commerce Platform to your website.",
    category: "Ecommerce",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/vtex/logo.png",
  },
  {
    blockKey: "deco-shopify",
    vendor: "deco",
    app: "shopify",
    title: "Shopify",
    description:
      "Loaders, actions and workflows for adding Shopify Commerce Platform to your website.",
    category: "Ecommerce",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/shopify/logo.png",
  },
  {
    blockKey: "deco-vnda",
    vendor: "deco",
    app: "vnda",
    title: "VNDA",
    description:
      "Loaders, actions and workflows for adding VNDA Commerce Platform to your website.",
    category: "Ecommerce",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/vnda/logo.png",
  },
  {
    blockKey: "deco-wake",
    vendor: "deco",
    app: "wake",
    title: "Wake",
    description:
      "Loaders, actions and workflows for adding Wake Commerce Platform to your website.",
    category: "Ecommerce",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/wake/logo.png",
  },
  {
    blockKey: "deco-nuvemshop",
    vendor: "deco",
    app: "nuvemshop",
    title: "Nuvemshop",
    description:
      "Loaders, actions and workflows for adding Nuvemshop Commerce Platform to your website.",
    category: "Ecommerce",
    logo: "https://auth.deco.cx/storage/v1/object/public/assets/1/user_content/nuvemshop.png",
  },
  {
    blockKey: "deco-linx",
    vendor: "deco",
    app: "linx",
    title: "Linx",
    description:
      "Loaders, actions and workflows for adding Linx Commerce Platform to your website.",
    category: "Ecommerce",
    logo: "https://auth.deco.cx/storage/v1/object/public/assets/1/user_content/linx.png",
  },
  {
    blockKey: "deco-wap",
    vendor: "deco",
    app: "wap",
    title: "Uappi",
    description:
      "Loaders, actions and workflows for adding Uappi Commerce Platform to your website.",
    category: "Ecommerce",
    logo: "https://auth.deco.cx/storage/v1/object/public/assets/1/user_content/uappi.png",
  },
  {
    blockKey: "deco-sap",
    vendor: "deco",
    app: "sap",
    title: "SAP Commerce",
    description:
      "Loaders, actions and workflows for adding SAP Commerce Platform to your website.",
    category: "Ecommerce",
    logo: "https://decoims.com/decocms/389b8d9b-e102-4ee7-9e9b-9c81c433581a/Sap_fav.png",
  },
  {
    blockKey: "deco-streamshop",
    vendor: "deco",
    app: "streamshop",
    title: "Streamshop",
    description:
      "Incorporate videos into your eCommerce. Boost sales significantly with Video Commerce Streamshop.",
    category: "Ecommerce",
  },
  {
    blockKey: "deco-algolia",
    vendor: "deco",
    app: "algolia",
    title: "Algolia",
    description:
      "Product search & discovery that increases conversions at scale.",
    category: "Search",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/algolia/logo.png",
  },
  {
    blockKey: "deco-typesense",
    vendor: "deco",
    app: "typesense",
    title: "TypeSense",
    description:
      "Open source search engine meticulously engineered for performance & ease-of-use.",
    category: "Search",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/typesense/logo.png",
  },
  {
    blockKey: "deco-smarthint",
    vendor: "deco",
    app: "smarthint",
    title: "SmartHint",
    description:
      "Smart search and product recommendation to improve your eCommerce customer experience.",
    category: "Search",
    logo: "https://github.com/deco-cx/apps/blob/main/smarthint/logo.png?raw=true",
  },
  {
    blockKey: "deco-linx-impulse",
    vendor: "deco",
    app: "linx-impulse",
    title: "Linx Impulse",
    description:
      "Build, manage and deliver B2B, B2C and Marketplace commerce experiences.",
    category: "Search",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/linx-impulse/logo.png",
  },
  {
    blockKey: "deco-verified-reviews",
    vendor: "deco",
    app: "verified-reviews",
    title: "Verified Reviews",
    description: "A specialized solution in the collection of customer reviews",
    category: "Review",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/verified-reviews/logo.png",
  },
  {
    blockKey: "deco-power-reviews",
    vendor: "deco",
    app: "power-reviews",
    title: "Power Reviews",
    description:
      "Collect more and better Ratings & Reviews and other UGC. Create UGC displays that convert. Analyze to enhance product experience and positioning.",
    category: "Review",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/power-reviews/logo.png",
  },
  {
    blockKey: "deco-konfidency",
    vendor: "deco",
    app: "konfidency",
    title: "Konfidency",
    description: "Product reviews and store reviews.",
    category: "Review",
    logo: "https://auth.deco.cx/storage/v1/object/public/assets/1/user_content/konfidency.png",
  },
  {
    blockKey: "deco-ra-trustvox",
    vendor: "deco",
    app: "ra-trustvox",
    title: "RA Trustvox",
    description: "RA Trustvox reviews.",
    category: "Review",
    logo: "https://auth.deco.cx/storage/v1/object/public/assets/1/user_content/ra-trustvox.png",
  },
  {
    blockKey: "deco-analytics",
    vendor: "deco",
    app: "analytics",
    title: "Deco Analytics",
    description:
      "Measure your site traffic at a glance in a simple and modern web analytics dashboard.",
    category: "Analytics",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/analytics/logo.png",
  },
  {
    blockKey: "deco-posthog",
    vendor: "deco",
    app: "posthog",
    title: "PostHog",
    description:
      "All-in-one platform for product analytics, feature flags, session replays, experiments, and surveys, built for developers.",
    category: "Analytics",
    logo: "https://decoims.com/decocms/cb17e9dc-8772-4873-8dae-f5a9f99694d4/posthog-icon-logo-png_seeklogo-483563.png",
  },
  {
    blockKey: "deco-resend",
    vendor: "deco",
    app: "resend",
    title: "Resend",
    description:
      "Resend is an email platform that helps developers build and send transactional and marketing emails.",
    category: "Email",
    logo: "https://auth.deco.cx/storage/v1/object/public/assets/1/user_content/resend-logo.png",
  },
  {
    blockKey: "deco-mailchimp",
    vendor: "deco",
    app: "mailchimp",
    title: "Mailchimp",
    description:
      "Email and marketing automations platform for growing businesses.",
    category: "Email",
    logo: "https://assets.decocache.com/admin/094cf93f-f1cb-4ef1-b993-9d9785b3cd0c/channels4_profile-(1).jpg",
  },
  {
    blockKey: "deco-blog",
    vendor: "deco",
    app: "blog",
    title: "Deco Blog",
    description: "Manage your posts.",
    category: "Content",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/weather/logo.png",
  },
  {
    blockKey: "deco-weather",
    vendor: "deco",
    app: "weather",
    title: "Weather",
    description:
      "Vary your content based on the current weather of your visitors.",
    category: "Tool",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/weather/logo.png",
  },
];
