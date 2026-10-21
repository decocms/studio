import type { SiteAppRegistryEntry } from "./types";

/**
 * Installable apps for a TanStack deco site, from the `packages/apps-*`
 * workspaces of https://github.com/decocms/blocks.
 *
 * The `apps-` prefix is the starting filter, but the real test is whether the
 * package ships a `src/registry.ts` exporting an `AppRegistryEntry` — that is
 * what `autoconfigApps` consumes. `apps-commerce` and `apps-website` are base
 * libraries with no block key; `apps-algolia`, `apps-magento` and
 * `apps-salesforce` are loader-only and have no `mod.ts` to configure yet.
 *
 * `blockKey` mirrors the one each package declares for itself, so an app
 * installed here is the same block the site's runtime already looks up.
 */
export const TANSTACK_SITE_APPS: readonly SiteAppRegistryEntry[] = [
  {
    blockKey: "deco-vtex",
    vendor: "deco",
    app: "vtex",
    title: "VTEX",
    description: "VTEX IO commerce integration",
    category: "Ecommerce",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/vtex/logo.png",
    npm: { name: "@decocms/apps-vtex", registryExport: "VTEX_REGISTRY_ENTRY" },
  },
  {
    blockKey: "deco-shopify",
    vendor: "deco",
    app: "shopify",
    title: "Shopify",
    description: "Shopify Storefront API commerce integration",
    category: "Ecommerce",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/shopify/logo.png",
    npm: {
      name: "@decocms/apps-shopify",
      registryExport: "SHOPIFY_REGISTRY_ENTRY",
    },
  },
  {
    blockKey: "deco-wake",
    vendor: "deco",
    app: "wake",
    title: "Wake",
    description: "Wake Commerce (Storefront API) integration",
    category: "Ecommerce",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/wake/logo.png",
    npm: { name: "@decocms/apps-wake", registryExport: "WAKE_REGISTRY_ENTRY" },
  },
  {
    blockKey: "deco-nuvemshop",
    vendor: "deco",
    app: "nuvemshop",
    title: "Nuvemshop",
    description: "Nuvemshop (Tiendanube) Storefront API commerce integration",
    category: "Ecommerce",
    logo: "https://auth.deco.cx/storage/v1/object/public/assets/1/user_content/nuvemshop.png",
    npm: {
      name: "@decocms/apps-nuvemshop",
      registryExport: "NUVEMSHOP_REGISTRY_ENTRY",
    },
  },
  {
    blockKey: "deco-resend",
    vendor: "deco",
    app: "resend",
    title: "Resend",
    description: "Transactional email via Resend",
    category: "Email",
    logo: "https://auth.deco.cx/storage/v1/object/public/assets/1/user_content/resend-logo.png",
    npm: {
      name: "@decocms/apps-resend",
      registryExport: "RESEND_REGISTRY_ENTRY",
    },
  },
  {
    blockKey: "deco-blog",
    vendor: "deco",
    app: "blog",
    title: "Blog",
    description: "Blog posts, categories, and authors from CMS collections",
    category: "Content",
    logo: "https://raw.githubusercontent.com/deco-cx/apps/main/weather/logo.png",
    npm: { name: "@decocms/apps-blog", registryExport: "BLOG_REGISTRY_ENTRY" },
  },
];
