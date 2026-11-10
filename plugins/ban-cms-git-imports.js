/**
 * Lint plugin for the hosted CMS's first condition: no GitHub in any content
 * operation (design "Conditions of satisfaction", 1).
 *
 * The hosted CMS on R2 — its Studio API route, every `hosted/` module and
 * the web editor's client for it — must not import the git layer: not
 * `git-providers` (the GitHub client) and not the repo readers
 * (`decofile/repo-content-storage`, `decofile/read-decofile`). A test runs
 * the whole lifecycle with the GitHub client set to throw
 * (`cms-lifecycle.test.ts`); this rule keeps the imports from coming back.
 *
 * The web editor's content backend is covered too: the hook that picks the
 * backend (`use-content-backend.ts`), the hosted CMS client
 * (`content-protocol-api.ts`, `cms-*.ts`) and the hosted Publish and
 * Releases clients.
 *
 * `decofile.ts` and `sandbox-proxy.ts` stay outside it: they serve v7 Fast
 * Preview and sandboxes from git. For a Blocks v8 project (its marker) they
 * refuse the git writes and the git popover routes before any repository
 * lookup (`decofile-v8.test.ts`, `hostedV8GitGone`).
 */

import { resolveRelative } from "./resolve-relative.js";

/** The files the rule covers. Suffix-matched (`*` matches a file-name part). */
const COVERED = [
  /apps\/api\/src\/api\/routes\/cms(-[a-z-]+)?\.ts$/,
  /apps\/api\/src\/hosted\/[a-z0-9-]+(\.test)?\.ts$/,
  /apps\/api\/src\/storage\/cms-drafts\.ts$/,
  /apps\/web\/src\/components\/sections-editor\/cms-[a-z-]+\.ts$/,
  /apps\/web\/src\/components\/sections-editor\/use-content-backend\.ts$/,
  /apps\/web\/src\/components\/sections-editor\/content-protocol-api\.ts$/,
  /apps\/web\/src\/components\/sections-editor\/content-write-keys\.ts$/,
  /apps\/web\/src\/components\/thread\/repository\/hosted-publish-api\.ts$/,
  /apps\/web\/src\/layouts\/main-panel-tabs\/releases-api\.ts$/,
];

/** What the covered files may not import, as resolved paths. */
const BANNED = [
  /(^|\/)git-providers(\/|$)/,
  /(^|\/)decofile\/(repo-content-storage|read-decofile)$/,
  /(^|\/)sections-editor\/decofile-api$/,
];

function resolveSpec(filename, spec) {
  const bare = spec.replace(/\.(ts|tsx|js)$/, "");
  if (bare.startsWith(".")) return resolveRelative(filename, bare);
  if (bare.startsWith("@/") && filename.includes("/apps/api/")) {
    return `apps/api/src/${bare.slice(2)}`;
  }
  if (bare.startsWith("@/") && filename.includes("/apps/web/")) {
    return `apps/web/src/${bare.slice(2)}`;
  }
  return bare;
}

const rule = {
  create(context) {
    const filename = context.filename ?? "";
    if (!COVERED.some((re) => re.test(filename))) return {};
    const check = (node) => {
      const src = node?.source;
      if (!src || src.type !== "Literal" || typeof src.value !== "string") {
        return;
      }
      const resolved = resolveSpec(filename, src.value);
      if (!BANNED.some((re) => re.test(resolved))) return;
      context.report({
        node: src,
        message:
          `Hosted CMS: "${src.value}" reaches the git layer. No content ` +
          "operation may call GitHub (design condition 1): read and write " +
          "R2 through hosted/cms-* instead.",
      });
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

const plugin = {
  meta: { name: "ban-cms-git-imports" },
  rules: { "ban-cms-git-imports": rule },
};

export default plugin;
