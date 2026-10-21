import type { PackageManager } from "../runtime-defaults";
import type { SiteTechnology } from "./types";

/** Scope of every package the TanStack stack publishes. */
const DECOCMS_SCOPE = "@decocms/";

/**
 * Packages whose declared range is the one a newly added `@decocms/apps-*`
 * should copy. They are released in lockstep from the same monorepo, so any
 * of them pins the right line; ordered by how certain each is to be a direct
 * dependency of a site.
 */
const VERSION_SOURCES = [
  "@decocms/blocks",
  "@decocms/tanstack",
  "@decocms/blocks-admin",
] as const;

/**
 * The stack implied by the package manager the project already runs with
 * (`metadata.runtime.selected`). A deco site on Deno is the Fresh stack; on
 * any Node-family manager it is TanStack. Null when the field is unset — the
 * project has not been started yet, and guessing would pick an install format
 * at random.
 *
 * This only decides which catalogue to OFFER. The install itself re-derives
 * the technology from the repository's own manifests, so a wrong guess here
 * can never write the wrong format.
 */
export function siteTechnologyFromPackageManager(
  selected: PackageManager | string | null | undefined,
): SiteTechnology | null {
  switch (selected) {
    case "deno":
      return "deno";
    case "bun":
    case "npm":
    case "pnpm":
    case "yarn":
      return "tanstack";
    default:
      return null;
  }
}

/** `/live/_meta`'s `framework` value, for the stacks that report one. */
const FRAMEWORK_TECHNOLOGY: Record<string, SiteTechnology> = {
  "tanstack-start": "tanstack",
};

/**
 * The stack a site's own `/live/_meta` reports — the cheapest signal there is,
 * since the CMS already holds that document in both runtimes.
 *
 * Fresh/Deno predates the `framework` field, so its ABSENCE is the Deno
 * answer. A framework nobody here knows yet returns null instead of a guess:
 * the caller then offers no catalogue, rather than the wrong one.
 */
export function siteTechnologyFromFramework(
  framework: string | null | undefined,
): SiteTechnology | null {
  if (!framework) return "deno";
  return FRAMEWORK_TECHNOLOGY[framework] ?? null;
}

export interface DetectedSiteTechnology {
  technology: SiteTechnology;
  /**
   * The version range to pin a new `@decocms/apps-*` at, copied from a
   * `@decocms/*` dependency the site already declares. Null on Deno (the
   * import map covers every app) and on a TanStack repo that declares none —
   * which is not a deco site, and the caller must refuse.
   */
  decocmsVersion: string | null;
}

function parseJson(
  text: string | null | undefined,
): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function dependencyRanges(
  pkg: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
    for (const [name, range] of Object.entries(
      deps as Record<string, unknown>,
    )) {
      if (typeof range === "string" && !(name in out)) out[name] = range;
    }
  }
  return out;
}

/**
 * A range only the package that declares it can resolve: a monorepo sibling,
 * a catalog entry, a path. Copying one onto a brand-new dependency pins it to
 * something the project has no entry for, and the install fails.
 */
const PROTOCOL_RANGE =
  /^(?:workspace|catalog|link|file|portal|npm|git|github):/;

export function isProtocolVersionRange(range: string): boolean {
  return PROTOCOL_RANGE.test(range);
}

/**
 * The range to copy, or null when the site declares no `@decocms/*` package.
 * A concrete range wins over a protocol one wherever both are declared; a
 * protocol range is still returned when it is all there is, so the caller can
 * name it in its refusal rather than reporting the site as not a deco site.
 */
export function decocmsVersionRange(packageJson: string | null): string | null {
  const pkg = parseJson(packageJson);
  if (!pkg) return null;
  const deps = dependencyRanges(pkg);
  const names = [
    ...VERSION_SOURCES,
    ...Object.keys(deps)
      .filter((name) => name.startsWith(DECOCMS_SCOPE))
      .sort(),
  ];
  let protocolRange: string | null = null;
  for (const name of names) {
    const range = deps[name];
    if (!range) continue;
    if (!isProtocolVersionRange(range)) return range;
    protocolRange ??= range;
  }
  return protocolRange;
}

/**
 * The range `name` is declared at, or null when the site does not depend on
 * it. Reads the manifest's own `dependencies`/`devDependencies` rather than
 * the file's text: `overrides` and `resolutions` mention a package without
 * depending on it, and treating them as a declaration skips both the
 * dependency and the install that would have fetched it.
 */
export function declaredDependencyRange(
  packageJson: string | null,
  name: string,
): string | null {
  const pkg = parseJson(packageJson);
  return pkg ? (dependencyRanges(pkg)[name] ?? null) : null;
}

/**
 * The authoritative read, from the manifests at the branch being written.
 * `deno.json` wins: a repository carrying both is a Deno site with tooling
 * around it, never a TanStack one.
 *
 * Returns null when neither manifest is present. Note that a TanStack result
 * with a null `decocmsVersion` is a Node repo that is not a deco site — the
 * installer refuses it rather than inventing a range.
 */
export function detectSiteTechnology(files: {
  denoJson: string | null;
  packageJson: string | null;
}): DetectedSiteTechnology | null {
  if (files.denoJson !== null) {
    return { technology: "deno", decocmsVersion: null };
  }
  if (files.packageJson !== null) {
    return {
      technology: "tanstack",
      decocmsVersion: decocmsVersionRange(files.packageJson),
    };
  }
  return null;
}
