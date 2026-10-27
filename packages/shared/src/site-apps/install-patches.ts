import { siteAppResolveType } from "./block";
import { declaredDependencyRange, isProtocolVersionRange } from "./technology";
import type { SiteAppRegistryEntry, SiteTechnology } from "./types";

/**
 * Installing a site app is a small set of file writes plus one decofile
 * block. This module builds them and nothing else: it is pure, so the CMS can
 * apply the result through the sandbox daemon and the server can land the very
 * same bytes as one commit.
 */

/** An install that cannot be completed without hand-editing the site. */
export class SiteAppInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteAppInstallError";
  }
}

export interface SiteAppFilePatch {
  /** Relative to the package root; callers prefix the project's package path. */
  path: string;
  content: string;
}

export interface InstallAppPatches {
  files: SiteAppFilePatch[];
  block: { key: string; value: Record<string, unknown> };
  /**
   * The npm package the written module imports, which has to be in
   * `node_modules` before that module exists. Set whether or not
   * `package.json` needed patching: an install that failed after the manifest
   * landed must still install on the retry. Null on Deno, where the import
   * map covers every app.
   */
  dependency: string | null;
}

export interface MakeInstallAppPatchesInput {
  technology: SiteTechnology;
  entry: SiteAppRegistryEntry;
  /** TanStack: the range to pin the new package at. */
  decocmsVersion?: string | null;
  /** TanStack: current `package.json` text. */
  packageJson?: string | null;
  /** TanStack: current `src/setup.ts` text. */
  setupTs?: string | null;
}

/** `linx-impulse` -> `linxImpulseMod`, the alias the registry entry overrides with. */
function moduleAlias(app: string): string {
  const camel = app.replace(/[-_.]+(.)/g, (_, c: string) => c.toUpperCase());
  const safe = camel.replace(/[^A-Za-z0-9$_]/g, "");
  return `${/^[0-9]/.test(safe) ? `app${safe}` : safe}Mod`;
}

function denoAppFile(entry: SiteAppRegistryEntry): SiteAppFilePatch {
  const specifier = `apps/${entry.app}/mod.ts`;
  return {
    path: `apps/${entry.vendor}/${entry.app}.ts`,
    content: `export { default } from "${specifier}";\nexport * from "${specifier}";\n`,
  };
}

/**
 * Under the vendor directory, so the path agrees with the block's
 * resolveType: the generator keys an app by its path below `src/`, and a site
 * template that happens to keep its own apps flat (`src/apps/shopify.ts`)
 * still generates nested ones — a Fresh-migrated site is wholly nested.
 */
function tanstackAppFile(
  entry: SiteAppRegistryEntry,
  pkg: string,
): SiteAppFilePatch {
  return {
    path: `src/apps/${entry.vendor}/${entry.app}.ts`,
    content: `export * from "${pkg}/mod";\n`,
  };
}

// ---- package.json -----------------------------------------------------------

/** End index (exclusive) of the `{...}` opening at `open`, skipping strings. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  throw new SiteAppInstallError("package.json: unbalanced braces");
}

/** Index of the first character at or after `from` that JSON does not skip. */
function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && " \t\r\n".includes(text[i]!)) i++;
  return i;
}

/**
 * Index of the `{` opening the manifest's OWN `dependencies`. Found by depth
 * rather than by the first match: `pnpm`, `overrides` and `resolutions` all
 * nest a block under the same key, and writing into one of those adds a
 * dependency the package manager never installs.
 */
function topLevelDependenciesOpen(text: string): number {
  let depth = 0;
  let quote = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === '"') {
        quote = false;
        if (depth !== 1 || text.slice(start + 1, i) !== "dependencies")
          continue;
        const colon = skipSpace(text, i + 1);
        if (text[colon] !== ":") continue;
        const open = skipSpace(text, colon + 1);
        if (text[open] === "{") return open;
      }
      continue;
    }
    if (ch === '"') {
      quote = true;
      start = i;
    } else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return -1;
}

/**
 * Add `name: range` to `dependencies`, in alphabetical position, touching
 * nothing else in the file. A whole-file reparse would normalize formatting
 * the site owns and turn a one-line install into a review-sized diff.
 */
function addDependency(
  packageJson: string,
  name: string,
  range: string,
): string {
  const open = topLevelDependenciesOpen(packageJson);
  if (open === -1) {
    throw new SiteAppInstallError(
      'package.json has no "dependencies" — add it before installing an app',
    );
  }
  const close = matchingBrace(packageJson, open);
  const body = packageJson.slice(open + 1, close);

  const entries = [...body.matchAll(/^([ \t]*)"((?:[^"\\]|\\.)*)"\s*:/gm)];
  const indent = entries[0]?.[1] ?? "    ";
  const closeIndent = /(^|\n)([ \t]*)$/.exec(body)?.[2] ?? "  ";
  const line = `${indent}${JSON.stringify(name)}: ${JSON.stringify(range)}`;

  if (entries.length === 0) {
    return `${packageJson.slice(0, open + 1)}\n${line}\n${closeIndent}${packageJson.slice(close)}`;
  }

  const before = entries.find((entry) => entry[2]! > name);
  if (before) {
    const at = open + 1 + before.index;
    return `${packageJson.slice(0, at)}${line},\n${packageJson.slice(at)}`;
  }
  // Append after the last entry, which has no trailing comma to reuse.
  const last = entries[entries.length - 1]!;
  const lastLineEnd = body.indexOf("\n", last.index);
  const at = open + 1 + (lastLineEnd === -1 ? body.length : lastLineEnd);
  return `${packageJson.slice(0, at)},\n${line}${packageJson.slice(at)}`;
}

// ---- src/setup.ts -----------------------------------------------------------

/**
 * Where an import declaration ENDS — at its specifier. `import "./x";` and
 * `... } from "pkg";` both end this way, including a clause wrapped over
 * several lines; anchoring on the `import` LINE instead lands an insertion
 * inside such a clause and the file stops parsing.
 */
const IMPORT_END = /(?:^import\s*|\bfrom\s*)(["'])[^"'\n]*\1[ \t]*;?/gm;

/** A locally declared `const APP_REGISTRY ... = [` to insert an entry into. */
const APP_REGISTRY_ARRAY = /const\s+APP_REGISTRY\b[^=]*=\s*\[/;

/**
 * `APP_REGISTRY` imported rather than declared — the legacy wiring, where it
 * came from the monolithic `@decocms/apps` package whose registry covered
 * every platform at once. A per-package entry has nowhere to go there, and
 * adding one of the split `@decocms/apps-*` packages would not register it.
 */
function importsAppRegistry(setupTs: string): boolean {
  // Clause scanned whole, then searched: a `\{[^}]*APP_REGISTRY` rescans to
  // EOF from every `import {` that never closes, which is quadratic.
  const clauses = setupTs.match(/\bimport\s*\{[^{}]*\}\s*from\b/g) ?? [];
  return clauses.some((clause) => /\bAPP_REGISTRY\b/.test(clause));
}

/**
 * Wire the app into the site's `APP_REGISTRY`. That array is what
 * `autoconfigApps(blocks, APP_REGISTRY)` matches the decofile block against;
 * without an entry the block exists and the app never configures.
 *
 * The entry overrides `module` with a statically imported namespace, as the
 * template does: the package's own lazy `() => import("./mod")` does not
 * survive a Workers bundle.
 */
function addRegistryEntry(
  setupTs: string,
  entry: SiteAppRegistryEntry,
  pkg: NonNullable<SiteAppRegistryEntry["npm"]>,
): string {
  const alias = moduleAlias(entry.app);
  const imports =
    `\nimport { ${pkg.registryExport} } from "${pkg.name}/registry";` +
    `\nimport * as ${alias} from "${pkg.name}/mod";`;
  const line = `  { ...${pkg.registryExport}, module: async () => ${alias} as never },`;

  const arrayMatch = APP_REGISTRY_ARRAY.exec(setupTs);
  if (!arrayMatch) {
    throw new SiteAppInstallError(
      "This site does not register apps through `autoconfigApps`: src/setup.ts declares no `APP_REGISTRY` array for the entry. Add one and call `autoconfigApps(blocks, APP_REGISTRY)`, then reinstall — or wire this app by hand.",
    );
  }
  const lastImport = [...setupTs.matchAll(IMPORT_END)]
    .filter((m) => m.index < arrayMatch.index)
    .pop();
  if (!lastImport) {
    throw new SiteAppInstallError("src/setup.ts has no imports to extend");
  }

  const importsAt = lastImport.index + lastImport[0].length;
  // Prepended: autoconfigApps ignores order, so `[` needs no bracket matching.
  const openAt = arrayMatch.index + arrayMatch[0].length;
  const tail = setupTs.slice(openAt);
  return [
    setupTs.slice(0, importsAt),
    imports,
    setupTs.slice(importsAt, openAt),
    `\n${line}`,
    /^\s*\]/.test(tail) ? `\n${tail.replace(/^\s*\]/, "]")}` : tail,
  ].join("");
}

// ---- entry point ------------------------------------------------------------

/**
 * The files and the block that install `entry` on a site. Idempotent: an
 * artifact already in place is left out of the patch set, so reinstalling the
 * same app produces no diff.
 */
export function makeInstallAppPatches(
  input: MakeInstallAppPatchesInput,
): InstallAppPatches {
  const { entry, technology } = input;
  const block = {
    key: entry.blockKey,
    value: { __resolveType: siteAppResolveType(entry.vendor, entry.app) },
  };

  if (technology === "deno") {
    return { files: [denoAppFile(entry)], block, dependency: null };
  }

  const pkg = entry.npm;
  if (!pkg) {
    throw new SiteAppInstallError(
      `${entry.title} has no TanStack package — it is only available on Deno sites`,
    );
  }

  const packageJson = input.packageJson;
  const setupTs = input.setupTs;
  if (packageJson == null || setupTs == null) {
    throw new SiteAppInstallError(
      "Could not read the site's package.json and src/setup.ts",
    );
  }
  const version = input.decocmsVersion;
  if (!version) {
    throw new SiteAppInstallError(
      "This repository declares no @decocms/* dependency, so it is not a TanStack deco site",
    );
  }
  if (isProtocolVersionRange(version)) {
    throw new SiteAppInstallError(
      `@decocms/* is pinned at "${version}", which resolves only for a package this workspace already declares — add ${pkg.name} there, then reinstall`,
    );
  }

  const files = [tanstackAppFile(entry, pkg.name)];
  if (declaredDependencyRange(packageJson, pkg.name) === null) {
    files.push({
      path: "package.json",
      content: addDependency(packageJson, pkg.name, version),
    });
  }
  if (!APP_REGISTRY_ARRAY.test(setupTs) && importsAppRegistry(setupTs)) {
    throw new SiteAppInstallError(
      "This branch still wires apps through the monolithic `@decocms/apps` registry, which cannot see the split `@decocms/apps-*` packages. Move src/setup.ts to a local `APP_REGISTRY` array first.",
    );
  }
  if (!setupTs.includes(pkg.registryExport)) {
    files.push({
      path: "src/setup.ts",
      content: addRegistryEntry(setupTs, entry, pkg),
    });
  }
  return { files, block, dependency: pkg.name };
}
