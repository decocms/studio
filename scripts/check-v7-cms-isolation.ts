#!/usr/bin/env bun

/**
 * PR-specific source comparison, not a browser or whole-program equivalence proof.
 * Run: bun scripts/check-v7-cms-isolation.ts --base <base-ref>
 *
 * Bun parses and emits each comparison fragment, removing formatting, comments
 * and TypeScript-only syntax. The listed transport import moves, renamed legacy
 * declarations and explicitly labeled gate projections are normalized. Changed
 * files without emitted equality stay separate for manual reachability review.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args[0] === "--help") {
  console.log(
    "Usage: bun scripts/check-v7-cms-isolation.ts [--base <ref>]\nDefault base: origin/main. Comparisons use its merge-base with HEAD and the current working tree.",
  );
  process.exit(0);
}
if ((args[0] === "--base" && args.length !== 2) || args.length > 2) {
  throw new Error("Expected --base <ref> (or no arguments)");
}
const ref = (args[0] === "--base" ? args[1] : args[0]) ?? "origin/main";
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trimEnd();
const base = git("merge-base", ref, "HEAD");
const web = "apps/web/src/";
const sections = `${web}components/sections-editor/`;
const transpiler = new Bun.Transpiler({ loader: "tsx", target: "browser" });
const emitted = (source: string) => transpiler.transformSync(source).trim();
const compactTranspiler = new Bun.Transpiler({
  loader: "tsx",
  target: "browser",
  minifyWhitespace: true,
});
const canonical = (source: string) =>
  compactTranspiler.transformSync(source).trim();
const before = (path: string) => git("show", `${base}:${path}`);
const after = (path: string) => readFileSync(join(root, path), "utf8");

const moves = new Map(
  [
    "cms-api",
    "hosted-content",
    "content-protocol-api",
    "content-changes",
    "use-content-backend",
  ].map((name) => [`${sections}${name}`, `${web}cms/${name}`]),
);
moves.set(
  `${sections}fields/use-serve-asset-upload`,
  `${web}cms/use-asset-upload`,
);

function normalizeImports(source: string, path: string): string {
  return source.replace(
    /(\bfrom\s*["'])([^"']+)(["'])/g,
    (match, prefix: string, module: string, suffix: string) => {
      const resolved = module.startsWith("@/")
        ? `${web}${module.slice(2)}`
        : module.startsWith(".")
          ? posix.normalize(posix.join(dirname(path), module))
          : module;
      const stem = resolved.replace(/\.(?:tsx?|jsx?)$/, "");
      const destination = moves.get(stem);
      return destination
        ? `${prefix}@/${destination.slice(web.length)}${suffix}`
        : match;
    },
  );
}

/**
 * Formatted declarations end at their own indentation. Requiring one start and
 * compiling the extracted result makes an incomplete/ambiguous extraction fail.
 * This is deliberately narrower than a general TypeScript parser.
 */
function declaration(source: string, name: string, indent = ""): string {
  const start = new RegExp(
    `^${indent}(?:export )?(?:async )?(?:function ${name}\\b|const ${name}\\s*=)`,
    "gm",
  );
  const starts = [...source.matchAll(start)];
  if (starts.length !== 1) throw new Error(`Expected one declaration: ${name}`);
  const from = starts[0]!.index;
  const end = new RegExp(`^${indent}\\}(?:;)?\\s*$`, "gm");
  end.lastIndex = from;
  const closing = end.exec(source);
  if (!closing) throw new Error(`Missing declaration end: ${name}`);
  const fragment = source.slice(
    from,
    closing.index + closing[0].trimEnd().length,
  );
  emitted(fragment);
  return fragment;
}

function propertyCallback(
  source: string,
  property: string,
  indent: string,
): string {
  const start = new RegExp(`^${indent}${property}: async \\(\\) => \\{`, "gm");
  const starts = [...source.matchAll(start)];
  if (starts.length !== 1)
    throw new Error(`Expected one callback: ${property}`);
  const from = starts[0]!.index;
  const end = new RegExp(`^${indent}\\},$`, "gm");
  end.lastIndex = from;
  const closing = end.exec(source);
  if (!closing) throw new Error(`Missing callback end: ${property}`);
  const fragment = source
    .slice(from, closing.index + closing[0].length - 1)
    .replace(new RegExp(`^${indent}${property}:`), "const candidate =");
  emitted(fragment);
  return fragment;
}

const comparisons: string[] = [];
const failures: string[] = [];
function equal(label: string, left: string, right: string): void {
  if (canonical(left) !== canonical(right)) failures.push(label);
  else comparisons.push(label);
}

function replaceOnce(source: string, pattern: RegExp, value: string): string {
  const matches = [...source.matchAll(new RegExp(pattern.source, "g"))];
  if (matches.length !== 1)
    throw new Error(`Expected one projection site: ${pattern}`);
  return source.replace(pattern, value);
}

function withoutUnavailableGuard(source: string): string {
  return replaceOnce(
    source,
    /      if \(backend\.kind === "pending" \|\| backend\.kind === "unavailable"\) \{\n        throw protocolUnavailableError\("CMS storage"\);\n      \}\n/,
    "",
  );
}

function sameDeclaration(
  path: string,
  name: string,
  indent = "",
  currentPath = path,
  currentName = name,
): void {
  const canonicalName = (source: string, originalName: string) =>
    declaration(source, originalName, indent)
      .replace(/^(\s*)(?:export )?/, "$1")
      .replace(new RegExp(`\\b${originalName}\\b`), "candidate");
  equal(
    `${name}: ${path}`,
    canonicalName(before(path), name),
    canonicalName(after(currentPath), currentName),
  );
}

for (const name of ["selectContentBackend", "contentProbesEnabled"]) {
  sameDeclaration(`${sections}content-backend.ts`, name);
}
sameDeclaration("packages/shared/src/blocks-major.ts", "isBlocksV8Project");
for (const [file, name] of [
  ["use-save-block", "writeLegacy"],
  ["use-delete-block", "deleteLegacy"],
  ["use-move-blocks", "moveLegacy"],
] as const) {
  sameDeclaration(`${sections}${file}.ts`, name, "  ");
}
sameDeclaration(
  `${sections}use-decofile.ts`,
  "decofileCacheKey",
  "",
  `${web}cms/cache-key.ts`,
);
sameDeclaration(
  `${web}components/sandbox/blocks/page-json-panel.tsx`,
  "PageJsonPanel",
  "",
  `${web}components/sandbox/blocks/page-json-panel-legacy.tsx`,
  "LegacyPageJsonPanel",
);
sameDeclaration(
  `${sections}fields/any-of-field.tsx`,
  "AnyOfField",
  "",
  `${sections}fields/any-of-field.tsx`,
  "LoadedAnyOfField",
);
sameDeclaration(
  `${sections}variant-rule-editor.tsx`,
  "VariantRuleEditor",
  "",
  `${sections}variant-rule-editor.tsx`,
  "LoadedVariantRuleEditor",
);
sameDeclaration(`${sections}use-decofile.ts`, "useDecofile");
sameDeclaration(`${sections}use-live-meta.ts`, "useLiveMeta");
equal(
  "useDecofile query callback (all legacy read transports and retry fallbacks)",
  propertyCallback(before(`${sections}use-decofile.ts`), "queryFn", "    "),
  propertyCallback(after(`${sections}use-decofile.ts`), "queryFn", "    "),
);

for (const name of ["useDeleteBlock", "useMoveBlocks"]) {
  const file =
    name === "useDeleteBlock" ? "use-delete-block" : "use-move-blocks";
  const path = `${sections}${file}.ts`;
  equal(
    `${name}: entire hook except new guard for pending/unavailable (legacy cannot match)`,
    declaration(before(path), name),
    withoutUnavailableGuard(declaration(after(path), name)),
  );
}

const savePath = `${sections}use-save-block.ts`;
const saveProjection = (source: string, current: boolean) => {
  let fragment = declaration(source, "useSaveBlock");
  // Compare all surrounding call sites too: only the existing hosted-only
  // helper's implementation is removed, not the conditions that invoke it.
  fragment = fragment.replace(
    declaration(fragment, "saveHostedBlock", "  "),
    "  const saveHostedBlock = undefined;",
  );
  if (!current) return fragment;
  fragment = withoutUnavailableGuard(fragment);
  return replaceOnce(fragment, /    v8: backend\.kind !== "legacy",\n/, "");
};
equal(
  "useSaveBlock: entire hook outside existing hosted-only helper, nonlegacy guard and additive v8 result field",
  saveProjection(before(savePath), false),
  saveProjection(after(savePath), true),
);
equal(
  "useDebouncedSaveBlock: entire hook except additive v8 result field",
  declaration(before(savePath), "useDebouncedSaveBlock"),
  replaceOnce(
    declaration(after(savePath), "useDebouncedSaveBlock"),
    /    v8: saveBlock\.v8,\n/,
    "",
  ),
);
equal(
  "useDecofileCacheKey: same legacy branch (both backend predicates are false for legacy)",
  declaration(before(`${sections}use-decofile.ts`), "useDecofileCacheKey"),
  replaceOnce(
    declaration(after(`${sections}use-decofile.ts`), "useDecofileCacheKey"),
    /backend\.kind !== "legacy" && backend\.cacheKeySuffix !== undefined/,
    'backend.kind === "protocol"',
  ),
);

for (const path of [
  `${web}hooks/use-blocks-v8-project.ts`,
  `${web}hooks/use-deco-serve-connection.ts`,
  `${web}hooks/use-local-preview-url.ts`,
  `${sections}decofile-api.ts`,
  "packages/shared/src/blocks-major.ts",
]) {
  equal(`unchanged gate/legacy dependency: ${path}`, before(path), after(path));
}

// Negative controls use only strings in memory; the workspace is never mutated.
const writer = declaration(
  after(`${sections}use-save-block.ts`),
  "writeLegacy",
  "  ",
);
const gate = declaration(
  after(`${sections}content-backend.ts`),
  "selectContentBackend",
);
const controls = [
  [
    "legacy HTTP method",
    writer,
    writer.replace('method: "POST"', 'method: "PATCH"'),
  ],
  [
    "v8 gate",
    gate,
    gate.replace(
      'if (!input.v8) return "legacy";',
      'if (input.v8) return "legacy";',
    ),
  ],
] as const;
for (const [label, original, changed] of controls) {
  if (original === changed || canonical(original) === canonical(changed)) {
    failures.push(`negative control did not detect changed ${label}`);
  }
}

const invariants: string[] = [];
function invariant(label: string, condition: boolean): void {
  if (condition) invariants.push(label);
  else failures.push(label);
}
const boundary = emitted(
  declaration(after(`${web}cms/block-boundary.tsx`), "CmsBlockBoundary"),
);
invariant(
  "CmsBlockBoundary's first return bypasses new rendering for legacy",
  /if \(!load\.v8\)\s*return children;/.test(boundary) &&
    boundary.indexOf("return children;") === boundary.indexOf("return "),
);

const browserPath = `${web}components/sandbox/content/content-browser.tsx`;
for (const action of [
  "handleAddPageVariant",
  "handleDuplicateSection",
  "handleRenameSection",
  "submitRedirectDialog",
  "handleReschedulePost",
  "handleDuplicateBlog",
]) {
  const source = emitted(declaration(after(browserPath), action, "  "));
  const legacy = /\bconst legacy(?:Source)? =/.exec(source)?.index ?? -1;
  const boundary = source.indexOf("try {");
  invariant(
    `${action}: legacy preparation remains before first try (position check only)`,
    legacy >= 0 && boundary > legacy,
  );
}
invariant(
  "AnyOfField only unwraps a reference for the new boundary on nonlegacy backends",
  /const reference = backend\.kind !== "legacy" &&/.test(
    emitted(
      declaration(
        after(`${sections}fields/any-of-field.tsx`),
        "ConnectedAnyOfField",
      ),
    ),
  ),
);
invariant(
  "VariantRuleEditor only mounts the new boundary on nonlegacy backends",
  /if \(backend\.kind !== "legacy" &&/.test(
    emitted(
      declaration(
        after(`${sections}variant-rule-editor.tsx`),
        "ConnectedVariantRuleEditor",
      ),
    ),
  ),
);

const identical: string[] = [];
const reviewed: string[] = [];
const files = git("diff", "--name-status", "--find-renames", base, "--", web)
  .split("\n")
  .filter(Boolean);
for (const line of files) {
  const [status, oldPath, newPath] = line.split("\t");
  const path = newPath ?? oldPath!;
  if (!/\.tsx?$/.test(path) || /\.(?:test|spec)\.tsx?$/.test(path)) continue;
  if (status === "D")
    throw new Error(`Deleted production source needs review: ${path}`);
  if (status === "A") {
    reviewed.push(path);
    continue;
  }
  const oldSource = normalizeImports(before(oldPath!), oldPath!);
  const currentSource = normalizeImports(after(path), path);
  if (canonical(oldSource) === canonical(currentSource)) identical.push(path);
  else reviewed.push(path);
}

console.log(`Baseline: ${base} (merge-base of ${ref} and HEAD)`);
console.log(`Current HEAD: ${git("rev-parse", "HEAD")}`);
console.log(
  `Working tree: ${git("status", "--porcelain").length ? "contains uncommitted changes; checks read current files" : "clean"}`,
);
console.log(`PASS: ${comparisons.length} explicit compiler-output comparisons`);
for (const label of comparisons) console.log(`  = ${label}`);
console.log(
  `PASS: ${controls.length} in-memory negative controls detected changes`,
);
console.log(`PASS: ${invariants.length} explicit source gate invariants`);
for (const label of invariants) console.log(`  > ${label}`);
console.log(
  `EMITTED EQUAL: ${identical.length} changed production modules after listed import moves`,
);
for (const path of identical) console.log(`  = ${path}`);
console.log(
  `NOT EMITTED EQUAL: ${reviewed.length} changed/new production modules (gate review recorded in apps/web/docs/v7-cms-isolation-proof.md; source equality is not claimed)`,
);
for (const path of reviewed) console.log(`  ? ${path}`);
console.log(
  "Scope: source comparisons only. This does not execute browser flows or prove every changed module unreachable from v7.",
);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
}
