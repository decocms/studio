/**
 * Lint plugin for the hosted CMS's first condition: no GitHub in any content
 * operation (design "Conditions of satisfaction", 1).
 *
 * The hosted CMS on R2 — its Studio API route, its `hosted/` modules and the
 * web editor's client for it — must not import the git layer: not
 * `git-providers` (the GitHub client), not the repo readers
 * (`decofile/repo-content-storage`, `decofile/read-decofile`), and not the v8
 * git path's own modules (`hosted/publish`, `release-objects`, `releases`,
 * `reapply`, `scope`, `blocks-major`, `draft-content-storage`,
 * `draft-save-request`), which reach GitHub themselves. A test runs the
 * whole lifecycle with the GitHub client set to throw
 * (`cms-lifecycle.test.ts`); this rule keeps the imports from coming back.
 *
 * Covered files are listed below by path, since the v8 git path still lives
 * beside them in `hosted/` until it is deleted; widen the list to the whole
 * directory then.
 */

import { resolveRelative } from "./resolve-relative.js";

/** The files the rule covers. Suffix-matched (`*` matches a file-name part). */
const COVERED = [
  /apps\/api\/src\/api\/routes\/cms(-[a-z-]+)?\.ts$/,
  /apps\/api\/src\/hosted\/cms-[a-z-]+\.ts$/,
  /apps\/api\/src\/hosted\/(block-version|revision-id|record-store|via|save-guards|blocks-major-marker)\.ts$/,
  /apps\/api\/src\/storage\/cms-drafts\.ts$/,
  /apps\/web\/src\/components\/sections-editor\/cms-[a-z-]+\.ts$/,
];

/** What the covered files may not import, as resolved paths. */
const BANNED = [
  /(^|\/)git-providers(\/|$)/,
  /(^|\/)decofile\/(repo-content-storage|read-decofile)$/,
  /(^|\/)hosted\/(publish|release-objects|releases|reapply|scope|blocks-major|draft-content-storage|draft-save-request|draft-store|draft-editors)$/,
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
