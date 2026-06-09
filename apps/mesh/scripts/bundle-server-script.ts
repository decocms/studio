#!/usr/bin/env bun
/**
 * Server and migration script bundler - bundles both server and migration scripts
 * Prunes node_modules to only include required dependencies for both scripts
 * Uses @vercel/nft to trace file dependencies
 *
 * Usage:
 *   bun run scripts/bundle-server-script.ts [--dist <path>]
 *
 * Options:
 *   --dist <path>  Output directory for pruned node_modules, server.js, and migrate.js (default: ./dist/server)
 */

import { nodeFileTrace } from "@vercel/nft";
import { cp, mkdir, readFile, stat } from "fs/promises";
import { dirname, join, resolve } from "path";
import { existsSync } from "fs";
import { $ } from "bun";

const SCRIPT_DIR =
  import.meta.dir || dirname(new URL(import.meta.url).pathname);
const SERVER_ENTRY_POINT = join(SCRIPT_DIR, "../src/index.ts");
const CLI_ENTRY_POINT = join(SCRIPT_DIR, "../src/cli.ts");
const ALWAYS_INCLUDE = [
  "@jitl/quickjs-wasmfile-release-sync",
  "@anthropic-ai/claude-agent-sdk",
  "@dbos-inc/dbos-sdk",
  "embedded-postgres",
  "ink",
  "react",
  "react-dom",
  "@inkjs/ui",
  // OTel v2 packages use conditional `exports` maps and lazy `require()`s
  // (e.g. sdk-metrics → resources) that @vercel/nft can't follow statically.
  // When nft silently drops one, `bun build --target bun` still externalizes
  // the `from "@opentelemetry/..."` call — so the published cli.js then
  // crashes at startup with "Cannot find module '@opentelemetry/...'" and
  // takes the deco bin down with it (decocms#2.393.0 incident).
  //
  // Force-include every `@opentelemetry/*` package that apps/mesh declares
  // as a direct dependency, so each becomes its own nft entry point and
  // gets copied into dist/server/node_modules/. Transitive-only OTel
  // packages (context-async-hooks, otlp-exporter-base, otlp-transformer,
  // semantic-conventions) are NOT listed here: bun's isolated install
  // (node_modules/.bun/...) doesn't surface them at apps/mesh's level,
  // so `Bun.resolveSync` would fail. They're still picked up by nft as
  // transitives of the direct entries — verified by inspecting the 2.393.0
  // tarball which shipped them despite neither version listing them
  // directly. The static verifier at the end of main() will fail the build
  // if any externalized `@opentelemetry/*` package goes missing.
  //
  // If you add a NEW direct `@opentelemetry/*` import to apps/mesh, add it
  // both to apps/mesh/package.json AND to this list.
  "@opentelemetry/api",
  "@opentelemetry/api-logs",
  "@opentelemetry/core",
  "@opentelemetry/exporter-logs-otlp-proto",
  "@opentelemetry/exporter-prometheus",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/instrumentation-runtime-node",
  "@opentelemetry/resources",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/sdk-node",
  "@opentelemetry/sdk-trace-base",
  // The better-auth family: every one of these uses a package.json `exports`
  // map with a non-standard "dev-source" condition listed BEFORE "default",
  // which makes @vercel/nft give up part-way and report 0 traced files from
  // the source-level import path. Without nft seeing them, bun build inlines
  // their code into cli.js/server.js, while their internal cross-package
  // imports (e.g. `from "ms"`, `from "@better-auth/core/utils"`) stay
  // externalized — so at runtime the bundle reaches into top-level
  // dist/server/node_modules/<pkg>/ for whichever version of <pkg> happened
  // to win the last-write-wins dedupe. That mismatched the inlined source
  // and crashed with cryptic SyntaxErrors:
  //   - "Export named 'ms' not found"  (better-auth needs ms@4 named exports
  //     but ms@2.1.3 won the dedupe; fix: list @decocms/better-auth here +
  //     nest ms@4 under it)
  //   - "Export named 'createRateLimitKey' not found in @better-auth/core/
  //     utils"  (better-auth@1.4.22 needs @better-auth/core@1.4.22, but
  //     @decocms/better-auth's transitive @better-auth/core@1.4.6-beta.3
  //     won; fix: list better-auth + @better-auth/sso here so nft sees the
  //     1.4.22 chain and nests it under better-auth/)
  //
  // Listing each better-auth-family package mesh imports here turns them
  // into nft root entries (nft starts from the resolved file, skipping the
  // broken exports map walk), so each version they need ends up in the
  // trace. The version-conflict handler in pruneNodeModules then hoists one
  // version and nests the rest under their consuming package's
  // node_modules/<dep>/, where Node's resolution walk finds them first.
  "@decocms/better-auth",
  "better-auth",
  "@better-auth/sso",
];
const ALWAYS_EXCLUDE = [
  "kysely-codegen",
  "@duckdb/node-bindings",
  "react-devtools-core",
];

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let distPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dist" && i + 1 < args.length) {
      distPath = args[i + 1];
      i++; // Skip the next argument as it's the value
    }
  }

  return { distPath };
}

// Find the workspace root (where node_modules is located)
// Script is at apps/mesh/scripts, so we need to go up three levels to the repo root
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, "../../..");
const MESH_APP_ROOT = resolve(SCRIPT_DIR, "..");

// Get dist path from args or use default
const { distPath } = parseArgs();
const OUTPUT_DIR = distPath
  ? resolve(distPath)
  : join(process.cwd(), "dist/server");

// Cache to store resolved package names for directories to avoid repeated FS calls
// Map<directoryPath, { name: string, version: string, path: string } | null>
const packageCache = new Map<
  string,
  { name: string; version: string; path: string } | null
>();

/**
 * Walks up the directory tree from a file path to find the enclosing package.json
 * and returns the package name, version, and its root directory.
 */
async function resolvePackage(
  filePath: string,
  rootDir: string,
): Promise<{ name: string; version: string; path: string } | null> {
  // Convert to absolute path if it isn't already
  let currentDir = resolve(rootDir, filePath);

  // If it's a file, start from its directory
  const stats = await stat(currentDir);
  if (!stats.isDirectory()) {
    currentDir = dirname(currentDir);
  }

  // Traverse up until we leave the rootDir or hit the system root
  while (currentDir.startsWith(rootDir)) {
    // Check cache first
    if (packageCache.has(currentDir)) {
      return packageCache.get(currentDir)!;
    }

    const pkgJsonPath = join(currentDir, "package.json");

    if (existsSync(pkgJsonPath)) {
      try {
        const content = await readFile(pkgJsonPath, "utf-8");
        const pkg = JSON.parse(content);
        const name = pkg.name;

        if (!name) {
          throw new Error(`Invalid package.json: ${pkgJsonPath}`);
        }

        // Some packages (esp. workspace roots like @decocms/*) omit
        // "version" — fall back to a sentinel so the dedup key still works.
        // Real npm packages always declare a version, so collisions on this
        // sentinel only happen between workspace packages, which we skip
        // copying anyway.
        const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
        const result = { name, version, path: currentDir };

        // Cache this result for this directory
        packageCache.set(currentDir, result);

        return result;
      } catch {
        // invalid package.json, keep walking
      }
    }

    // Move up one level
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break; // Reached system root
    currentDir = parentDir;
  }

  // Cache failure to avoid re-walking
  // Note: this might be too aggressive if we traverse deeply, but for node_modules usually fine
  return null;
}

// Copies a package directory with dereference: true. See the long comment
// inline below for why dereference is required (TL;DR: bun's isolated install
// is symlink-heavy, and `cp` without dereference recreates dangling symlinks
// in the output that survive build but fail at install time).
async function copyPackage(
  source: string,
  dest: string,
  label: string,
): Promise<void> {
  if (!existsSync(source)) {
    console.warn(`⚠️  Package source not found: ${label} at ${source}`);
    return;
  }
  try {
    // dereference: true — bun's isolated install routes many packages
    // through symlinks (apps/mesh/node_modules/@opentelemetry/api →
    // ../../../../node_modules/.bun/<pkg>@<ver>/..., plus per-package
    // peer-dep symlinks inside .bun/<pkg>@<ver>/node_modules/). nft's
    // fileList can return paths *through* those symlinks, so the
    // packagePath we resolved may itself be a symlinked directory.
    //
    // With dereference: false (the cp default), `cp` recreates the
    // symlink at the destination — and the link's relative target
    // (e.g. ../../../@opentelemetry+api@1.9.1/...) doesn't resolve
    // from dist/server/node_modules/. The build verifier passed
    // anyway because existsSync(symlinkPath) happened to resolve via
    // the still-present `.bun/` in the build dir, but `npm pack`
    // shipped the dangling symlink — and the published cli.js
    // crashed at startup with "Cannot find module '@opentelemetry/...'"
    // (decocms 2.393.5 incident, caught by the new smoke test).
    //
    // Forcing dereference: true copies the *real files* the link
    // resolves to, so dist/server/node_modules/ contains standalone
    // package directories that survive `npm pack` + reinstall.
    await cp(source, dest, { recursive: true, dereference: true });
    console.log(`✅ Copied package: ${label}`);
  } catch (error) {
    console.warn(`⚠️  Failed to copy package ${label}: ${error}`);
  }
}

async function pruneNodeModules(): Promise<Set<string>> {
  console.log(`🔍 Tracing dependencies for server and migration scripts...`);

  // Resolve migration entry points from mesh app root
  const migrateEntryPointPaths: string[] = [];
  for (const entryPoint of ALWAYS_INCLUDE) {
    try {
      const resolved = Bun.resolveSync(entryPoint, MESH_APP_ROOT);
      migrateEntryPointPaths.push(resolved);
      console.log(`📦 Migration entry point: ${entryPoint} -> ${resolved}`);
    } catch (error) {
      console.error(`❌ Failed to resolve ${entryPoint}:`, error);
      process.exit(1);
    }
  }

  // Resolve server entry point to absolute path
  const serverEntryPointPath = resolve(SERVER_ENTRY_POINT);
  if (!existsSync(serverEntryPointPath)) {
    console.error(`❌ Server entry point not found: ${serverEntryPointPath}`);
    process.exit(1);
  }
  console.log(`📦 Server entry point: ${serverEntryPointPath}`);

  // Resolve CLI entry point to absolute path
  const cliEntryPointPath = resolve(CLI_ENTRY_POINT);
  if (!existsSync(cliEntryPointPath)) {
    console.error(`❌ CLI entry point not found: ${cliEntryPointPath}`);
    process.exit(1);
  }
  console.log(`📦 CLI entry point: ${cliEntryPointPath}`);

  // Trace all file dependencies for all entry points
  const { fileList, reasons } = await nodeFileTrace(
    [...migrateEntryPointPaths, serverEntryPointPath, cliEntryPointPath],
    {
      base: WORKSPACE_ROOT,
    },
  );

  console.log(`📋 Found ${fileList.size} files in dependency tree`);

  // Collect every package the trace touched, deduped by (name, version).
  //
  // Why we can't just dedupe by name (the original behavior): when two
  // versions of the same package coexist in the dependency graph, last-write
  // wins, and the loser silently never ships. Concrete fallout caught by
  // smoke-tarball: @decocms/better-auth needs ms@4 (named exports, ESM-only)
  // while debug/express need ms@2.1.3 (default-callable CJS function). When
  // ms@2 won, better-auth's inlined `import { ms } from "ms"` crashed at
  // startup with "Export named 'ms' not found".
  //
  // Why not dedupe by ABSOLUTE PATH: bun's isolated install gives each
  // peer-resolved variant of a package its own bucket directory
  // (.bun/<pkg>@<ver>+<peer-hash>/...). Walking up from a traced file via
  // a symlinked peer dep lands you in the CONSUMER's bucket — so the same
  // (name, version) appears under many distinct paths. That blew up the
  // first attempt at this fix: @opentelemetry/api@1.9.1 (only one published
  // version) ended up nested under 20 different consumer packages because
  // each consumer's bucket was a different "path".
  //
  // (name, version) is the right grain: it matches how npm/bun's resolution
  // actually views identity, and avoids exploding duplicates of single-
  // version packages.
  type TracedPackage = { name: string; version: string; path: string };
  const tracedPackagesByKey = new Map<string, TracedPackage>(); // key: name@version
  const keyOf = (p: { name: string; version: string }) =>
    `${p.name}@${p.version}`;

  await Promise.all(
    Array.from(fileList).map(async (file) => {
      if (!file.includes("node_modules/")) return;
      const pkg = await resolvePackage(file, WORKSPACE_ROOT);
      if (pkg) tracedPackagesByKey.set(keyOf(pkg), pkg);
    }),
  );

  // Build (name@version) → set of importer package keys, by replaying nft's
  // reasons map. reasons.get(file).parents lists files that imported `file`;
  // walking each parent up to its enclosing package.json gives us the
  // consuming package. We collect by NAME (a.k.a. the importer's identity at
  // resolution time, not which symlinked path it was reached through) so
  // every nesting candidate gets credit from the full set of dependents.
  const importerNamesByKey = new Map<string, Set<string>>();
  await Promise.all(
    Array.from(reasons.entries()).map(async ([file, reason]) => {
      const owner = await resolvePackage(file, WORKSPACE_ROOT);
      if (!owner) return;
      const ownerKey = keyOf(owner);
      for (const parent of reason.parents ?? []) {
        const parentPkg = await resolvePackage(parent, WORKSPACE_ROOT);
        if (!parentPkg) continue;
        if (parentPkg.name === owner.name) continue; // self
        if (!importerNamesByKey.has(ownerKey)) {
          importerNamesByKey.set(ownerKey, new Set());
        }
        importerNamesByKey.get(ownerKey)!.add(parentPkg.name);
      }
    }),
  );

  // Group by name to find version conflicts.
  const versionsByName = new Map<string, TracedPackage[]>();
  for (const pkg of tracedPackagesByKey.values()) {
    if (!versionsByName.has(pkg.name)) versionsByName.set(pkg.name, []);
    versionsByName.get(pkg.name)!.push(pkg);
  }

  const conflictNames = [...versionsByName.entries()]
    .filter(([, vs]) => vs.length > 1)
    .map(
      ([name, vs]) =>
        `${name} (${vs
          .map((v) => v.version)
          .sort()
          .join(", ")})`,
    );
  if (conflictNames.length > 0) {
    console.log(
      `⚠️  ${conflictNames.length} packages with multiple versions:\n   - ${conflictNames.join("\n   - ")}`,
    );
  }

  // Create output directory structure
  if (existsSync(OUTPUT_DIR)) {
    console.log(`🧹 Cleaning existing ${OUTPUT_DIR}...`);
    await $`rm -rf ${OUTPUT_DIR}`.quiet();
  }
  const outputNodeModules = join(OUTPUT_DIR, "node_modules");
  await mkdir(outputNodeModules, { recursive: true });

  const successfullyCopied = new Set<string>();
  // Track which (consumerName, nestedName) pairs we've already nested so we
  // don't double-copy when several files in one consumer pull the same dep.
  const nestedCopiesCreated = new Set<string>();

  // For each package name, hoist the version with the most distinct consumer
  // packages (canonical), and nest the rest under their consumers'
  // node_modules/<name>/ — which is where Node's resolution algorithm checks
  // first when the consumer asks for `<name>`. Ties broken by version string
  // so builds are deterministic.
  for (const [packageName, versions] of versionsByName.entries()) {
    // Workspace packages stay inlined (bun build will pull source directly).
    // @decocms/better-auth is the one published @decocms/* dep, so it ships
    // like any other.
    if (
      packageName.startsWith("@decocms/") &&
      packageName !== "@decocms/better-auth"
    ) {
      console.log(`📦 Bundling inline (workspace): ${packageName}`);
      continue;
    }

    versions.sort((a, b) => {
      const ca = importerNamesByKey.get(keyOf(a))?.size ?? 0;
      const cb = importerNamesByKey.get(keyOf(b))?.size ?? 0;
      if (ca !== cb) return cb - ca; // more consumers = more canonical
      return a.version.localeCompare(b.version);
    });
    const [canonical, ...nested] = versions;

    await copyPackage(
      canonical.path,
      join(outputNodeModules, packageName),
      packageName,
    );
    successfullyCopied.add(packageName);

    // Nest non-canonical versions under each of their consumer packages.
    // Skipping versions with no known consumer would silently drop them
    // (the trace included them for some reason), so we WARN loudly instead —
    // the maintainer needs to decide whether to add the consumer to
    // ALWAYS_INCLUDE or accept that the version is unused.
    for (const v of nested) {
      const consumers = importerNamesByKey.get(keyOf(v));
      if (!consumers || consumers.size === 0) {
        console.warn(
          `⚠️  Could not place non-canonical ${packageName}@${v.version} — no consumer found in trace. Skipping (this version may not be reachable at runtime).`,
        );
        continue;
      }
      for (const consumerName of consumers) {
        if (consumerName === packageName) continue; // self
        const dedupKey = `${consumerName}\0${packageName}`;
        if (nestedCopiesCreated.has(dedupKey)) continue;
        nestedCopiesCreated.add(dedupKey);
        const dest = join(
          outputNodeModules,
          consumerName,
          "node_modules",
          packageName,
        );
        await copyPackage(
          v.path,
          dest,
          `${packageName}@${v.version} (nested under ${consumerName})`,
        );
      }
    }
  }

  console.log(
    `\n✅ Successfully copied ${successfullyCopied.size} packages to ${OUTPUT_DIR}`,
  );
  console.log(`📊 Output directory: ${OUTPUT_DIR}`);

  // Only return packages that were actually copied - these will be externalized
  // Workspace packages are not returned, so they get bundled inline
  return successfullyCopied;
}

async function buildMigrateScript(packagesToExternalize: Set<string>) {
  console.log("🔨 Building migrate.js...");

  const migrateSourcePath = join(SCRIPT_DIR, "../src/database/migrate.ts");
  const migrateOutputPath = join(OUTPUT_DIR, "migrate.js");

  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, { recursive: true });

  const commandsParts = [
    "bun",
    "build",
    migrateSourcePath,
    "--target",
    "bun",
    "--minify",
    "--production",
    "--outfile",
    migrateOutputPath,
  ];

  for (const pkg of packagesToExternalize) {
    commandsParts.push("--external", pkg);
  }
  for (const pkg of ALWAYS_EXCLUDE) {
    commandsParts.push("--external", pkg);
  }

  console.log(`🔨 Running command: ${commandsParts.join(" ")}`);
  // Build migrate.js
  await $`${commandsParts}`.quiet();

  if (!existsSync(migrateOutputPath)) {
    console.error("❌ Failed to build migrate.js");
    process.exit(1);
  }

  console.log(`✅ migrate.js built successfully at ${migrateOutputPath}`);
}

async function buildServerScript(packagesToExternalize: Set<string>) {
  console.log("🔨 Building server.js...");

  const serverSourcePath = join(SCRIPT_DIR, "../src/index.ts");
  const serverOutputPath = join(OUTPUT_DIR, "server.js");

  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, { recursive: true });

  const commandsParts = [
    "bun",
    "build",
    serverSourcePath,
    "--target",
    "bun",
    "--minify",
    "--production",
    "--outfile",
    serverOutputPath,
  ];

  for (const pkg of packagesToExternalize) {
    commandsParts.push("--external", pkg);
  }
  for (const pkg of ALWAYS_EXCLUDE) {
    commandsParts.push("--external", pkg);
  }

  console.log(`🔨 Running command: ${commandsParts.join(" ")}`);
  // Build server.js
  await $`${commandsParts}`.quiet();

  if (!existsSync(serverOutputPath)) {
    console.error("❌ Failed to build server.js");
    process.exit(1);
  }

  console.log(`✅ server.js built successfully at ${serverOutputPath}`);
}

async function buildCliScript(packagesToExternalize: Set<string>) {
  console.log("🔨 Building cli.js...");

  const cliSourcePath = CLI_ENTRY_POINT;
  const cliOutputPath = join(OUTPUT_DIR, "cli.js");

  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, { recursive: true });

  const commandsParts = [
    "bun",
    "build",
    cliSourcePath,
    "--target",
    "bun",
    "--minify",
    "--production",
    "--outfile",
    cliOutputPath,
  ];

  for (const pkg of packagesToExternalize) {
    commandsParts.push("--external", pkg);
  }
  for (const pkg of ALWAYS_EXCLUDE) {
    commandsParts.push("--external", pkg);
  }

  console.log(`🔨 Running command: ${commandsParts.join(" ")}`);
  // Build cli.js
  await $`${commandsParts}`.quiet();

  if (!existsSync(cliOutputPath)) {
    console.error("❌ Failed to build cli.js");
    process.exit(1);
  }

  console.log(`✅ cli.js built successfully at ${cliOutputPath}`);
}

async function copyRootReadme() {
  console.log("📄 Copying root README.md...");

  const readmeSourcePath = join(WORKSPACE_ROOT, "README.md");
  // Copy to parent dist folder so it's at dist/README.md (alongside dist/server and dist/client)
  const readmeOutputPath = join(OUTPUT_DIR, "..", "README.md");

  if (!existsSync(readmeSourcePath)) {
    console.warn("⚠️  Root README.md not found, skipping...");
    return;
  }

  try {
    await cp(readmeSourcePath, readmeOutputPath);
    console.log(`✅ README.md copied to ${readmeOutputPath}`);
  } catch (error) {
    console.warn(`⚠️  Failed to copy README.md: ${error}`);
  }
}

// QuickJS's emscripten loader resolves `new URL("emscripten-module.wasm",
// import.meta.url)` — on Linux bun in production this can resolve relative
// to the bundle output (dist/server/) rather than the externalized package,
// causing ENOENT. Copy the WASM alongside the bundles as a safety net so the
// file exists at whichever location bun looks.
async function copyQuickjsWasm() {
  console.log("📄 Copying QuickJS WASM...");

  const wasmSource = join(
    OUTPUT_DIR,
    "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
  );
  const wasmDest = join(OUTPUT_DIR, "emscripten-module.wasm");

  if (!existsSync(wasmSource)) {
    console.warn(`⚠️  QuickJS WASM not found at ${wasmSource}, skipping...`);
    return;
  }

  await cp(wasmSource, wasmDest);
  console.log(`✅ QuickJS WASM copied to ${wasmDest}`);
}

// host/runner.ts inlines packages/sandbox/daemon/dist/daemon.js via a
// text-import attribute. `bun build` needs that file present on disk to
// embed it into the server bundle, so produce it before bundling.
// Idempotent — `bun run build` just rewrites the same outfile.
async function buildSandboxDaemon() {
  console.log("🔨 Building sandbox daemon bundle...");
  const sandboxRoot = join(WORKSPACE_ROOT, "packages/sandbox");
  await $`bun run build`.cwd(sandboxRoot).quiet();
  const daemonBundle = join(sandboxRoot, "daemon/dist/daemon.js");
  if (!existsSync(daemonBundle)) {
    console.error(`❌ Sandbox daemon bundle missing at ${daemonBundle}`);
    process.exit(1);
  }
  console.log(`✅ Sandbox daemon bundle ready at ${daemonBundle}`);
}

// Node built-ins — these don't need to be in dist/server/node_modules/.
// Bun built-ins use the `bun:` prefix and are handled by string-prefix check.
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

// bun build --target bun emits ESM `from "pkg"` for externals (and CJS
// `require("pkg")` for the interop paths). Match both. The character class
// `[\w.-]` is enough for npm specifiers — npm names can't contain anything
// fancier. Tightened to require a quote-char terminator on both sides so we
// don't accidentally match prefix substrings.
const EXTERNAL_SPECIFIER_RES = [
  /\bfrom\s*["']((?:@[\w.-]+\/)?[\w.-]+)["']/g,
  /\bimport\s*\(\s*["']((?:@[\w.-]+\/)?[\w.-]+)["']\s*\)/g,
  /\bimport\s+["']((?:@[\w.-]+\/)?[\w.-]+)["']/g,
  /\brequire\s*\(\s*["']((?:@[\w.-]+\/)?[\w.-]+)["']\s*\)/g,
];

function extractExternalSpecifiers(bundleSource: string): Set<string> {
  const specs = new Set<string>();
  for (const re of EXTERNAL_SPECIFIER_RES) {
    re.lastIndex = 0;
    for (const m of bundleSource.matchAll(re)) {
      specs.add(m[1]);
    }
  }
  return specs;
}

// Prefixes whose packages the BUNDLER is solely responsible for shipping —
// not the consumer's install. These are devDeps (so `bun add decocms` won't
// install them) AND nft has a known blindspot for them (conditional exports
// + lazy requires). If the bundle references one and we didn't ship it,
// every consumer crashes at startup with "Cannot find module …".
//
// Other externals (e.g. `pg`, `node-fetch`, `react`) are resolved at runtime
// from the consumer's `node_modules/` (installed by `bun add decocms` via
// decocms's `dependencies` + their transitive closure). Trying to model
// that closure statically is brittle, so we don't.
const STRICT_SHIPPING_PREFIXES = ["@opentelemetry/"];

/**
 * Reads apps/mesh/package.json's runtime `dependencies` set. Anything listed
 * here is installed by the consumer's `bun add decocms` (via npm's standard
 * dependency resolution), so it does NOT need to be shipped inside
 * dist/server/node_modules/. The bundler's job is to ship the *gap* — the
 * devDeps + their transitive closure that the consumer install won't pull in.
 */
async function readConsumerInstalledDeps(): Promise<Set<string>> {
  const pkgJson = JSON.parse(
    await readFile(join(MESH_APP_ROOT, "package.json"), "utf-8"),
  ) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  return new Set([
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.optionalDependencies ?? {}),
  ]);
}

/**
 * Verifies every external `@opentelemetry/*` import in the built bundles
 * is resolvable at runtime: either shipped in dist/server/node_modules/, or
 * declared as a runtime `dependency` that the consumer's install resolves.
 *
 * Catches: "I added a new OTel import to observability/index.ts and forgot
 * to add it to ALWAYS_INCLUDE, so nft silently dropped the package and the
 * published cli.js crashes at startup with Cannot find module …". This is
 * the regression vector that caused the decocms#2.393.0 incident.
 *
 * Scoped to STRICT_SHIPPING_PREFIXES (currently `@opentelemetry/`) because:
 *   - All apps/mesh OTel devDeps go through nft's known-blindspot path
 *     (conditional exports + lazy requires)
 *   - Other packages (pg, react, …) are either runtime deps or consumer-
 *     installed transitives; modeling that closure statically is brittle
 *
 * Failure aborts the build before npm pack runs.
 */
async function verifyBundlesShipExternals() {
  console.log(
    "🔍 Verifying every externalized @opentelemetry/* import is resolvable...",
  );

  const consumerInstalled = await readConsumerInstalledDeps();
  const failures: { pkg: string; from: Set<string> }[] = [];
  const byPkg = new Map<string, Set<string>>();

  const entries = ["cli.js", "server.js", "migrate.js"];
  for (const entry of entries) {
    const entryPath = join(OUTPUT_DIR, entry);
    if (!existsSync(entryPath)) continue;

    const source = await readFile(entryPath, "utf-8");
    const specs = extractExternalSpecifiers(source);

    for (const spec of specs) {
      const pkgName = spec.startsWith("@")
        ? spec.split("/", 2).join("/")
        : spec.split("/", 1)[0];

      if (NODE_BUILTINS.has(pkgName)) continue;
      if (pkgName.startsWith("node:")) continue;
      if (pkgName.startsWith("bun:")) continue;
      if (
        !STRICT_SHIPPING_PREFIXES.some((prefix) => pkgName.startsWith(prefix))
      ) {
        continue;
      }
      // Consumer install resolves these — bundler doesn't need to ship them.
      if (consumerInstalled.has(pkgName)) continue;

      const pkgJsonPath = join(
        OUTPUT_DIR,
        "node_modules",
        pkgName,
        "package.json",
      );
      if (!existsSync(pkgJsonPath)) {
        const seen = byPkg.get(pkgName) ?? new Set<string>();
        seen.add(entry);
        byPkg.set(pkgName, seen);
      }
    }
  }
  for (const [pkg, from] of byPkg) failures.push({ pkg, from });

  if (failures.length > 0) {
    console.error(
      "\n❌ Bundle externalization mismatch — the build is broken.\n",
    );
    console.error(
      "These packages are imported by the published bundles but neither",
    );
    console.error(
      `shipped in ${OUTPUT_DIR}/node_modules/ nor declared as runtime`,
    );
    console.error(
      "`dependencies` (so consumer install won't bring them in):\n",
    );
    for (const f of failures) {
      console.error(
        `   - ${f.pkg}   (referenced from: ${[...f.from].join(", ")})`,
      );
    }
    console.error(
      "\nFix: add the top-level package to ALWAYS_INCLUDE in this file so",
    );
    console.error(
      "nft traces it as a root and copies it into dist/server/node_modules/.",
    );
    console.error(
      "\nDo NOT silence by adding to ALWAYS_EXCLUDE — that's for packages the",
    );
    console.error(
      "runtime never actually loads. These ARE loaded; the bundle references",
    );
    console.error("them.\n");
    process.exit(1);
  }

  console.log(
    `✅ Bundle externalization OK — every @opentelemetry/* import resolves.`,
  );
}

async function main() {
  // Build sandbox daemon bundle so runner.ts's text-import has a file to embed.
  await buildSandboxDaemon();

  // Prune node_modules to only include required dependencies for both scripts
  const packagesToExternalize = await pruneNodeModules();

  // Build migrate.js, server.js, and cli.js
  await buildMigrateScript(packagesToExternalize);
  await buildServerScript(packagesToExternalize);
  await buildCliScript(packagesToExternalize);

  // Copy root README.md to dist folder
  await copyRootReadme();

  // Copy QuickJS WASM alongside bundles as a safety net for path resolution
  await copyQuickjsWasm();

  // Defense in depth: fail the build if any external import points at a
  // package that isn't on disk. See verifyBundlesShipExternals for context.
  await verifyBundlesShipExternals();

  console.log("\n🎉 Build completed successfully!");
  console.log(`📦 Output directory: ${OUTPUT_DIR}`);
  console.log(`   - migrate.js`);
  console.log(`   - server.js`);
  console.log(`   - cli.js`);
  console.log(`   - emscripten-module.wasm`);
  console.log(`   - node_modules/`);
  console.log(`   - ../README.md`);
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
