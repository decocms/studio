/**
 * Site apps: the deco blocks a storefront installs to talk to a commerce
 * platform, a search engine, a reviews provider, and so on.
 *
 * The catalogue lives in this repository (see `./registry-deno` and
 * `./registry-tanstack`) rather than in a database, so the set of installable
 * apps ships and reviews with the code that knows how to install them.
 */

/**
 * Which deco stack a site is built on. Only these two can install apps: a
 * site on any other framework has no decofile for the block to land in.
 */
export type SiteTechnology = "deno" | "tanstack";

/** The npm package backing a TanStack app, and the const it exports. */
export interface SiteAppPackage {
  /** e.g. `@decocms/apps-vtex`. */
  name: string;
  /**
   * The `AppRegistryEntry` const exported from `<name>/registry`, e.g.
   * `VTEX_REGISTRY_ENTRY`. Spelled out rather than derived: a future package
   * with a hyphenated app name must not be guessed at.
   */
  registryExport: string;
}

export interface SiteAppRegistryEntry {
  /**
   * Decofile block key and catalogue id — `deco-vtex`. Matches the `blockKey`
   * the TanStack packages declare in their own `registry.ts`, which is what
   * `autoconfigApps` looks the block up by.
   */
  blockKey: string;
  /** Vendor segment of the block key and resolveType. `deco` for everything today. */
  vendor: string;
  /** App segment — `vtex`. The module path on both stacks is built from it. */
  app: string;
  title: string;
  description: string;
  category: string;
  logo?: string;
  /** TanStack only: Deno resolves apps through the `apps/` import-map alias. */
  npm?: SiteAppPackage;
}
