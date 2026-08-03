/**
 * Lint plugin enforcing the harness-extraction dependency DAG
 * (spec 2026-06-11-harness-extraction-design.md §12 step 0).
 *
 *   - Any file under `packages/`        → no `@/...` specifiers, no `apps/*` reach-ins.
 *   - Any file under `apps/api/src/harnesses/lib/` (the former @decocms/harness,
 *     folded into the API) → the same leaf discipline, kept as a directory rule:
 *     no `@/...` specifiers (flat HarnessDeps in, never the app tree), and
 *     additionally no `@aws-sdk/*` nor `@/core/studio-context`.
 *   - Other files outside `packages/` are not checked.
 */

function inPackages(filename) {
  return filename.includes("/packages/") || filename.startsWith("packages/");
}
function inHarnessLib(filename) {
  return (
    filename.includes("/apps/api/src/harnesses/lib/") ||
    filename.startsWith("apps/api/src/harnesses/lib/")
  );
}
function reachesAppsTree(spec) {
  return /(^|\/)apps\/[^/]+(\/|$)/.test(spec);
}
function isAtAlias(spec) {
  return spec.startsWith("@/");
}

const banCrossTreeImportsRule = {
  create(context) {
    const filename = context.filename ?? "";
    const harness = inHarnessLib(filename);
    if (!inPackages(filename) && !harness) return {};

    const checkSource = (node) => {
      const src = node?.source;
      if (!src || src.type !== "Literal" || typeof src.value !== "string") {
        return;
      }
      const spec = src.value;

      if (isAtAlias(spec)) {
        if (harness && spec === "@/core/studio-context") {
          context.report({
            node: src,
            message:
              "apps/api/src/harnesses/lib must not import @/core/studio-context — the harness reads flat HarnessDeps, never the recursive StudioContext (spec §4.2/§10.1).",
          });
          return;
        }
        context.report({
          node: src,
          message: `Cross-tree import banned: "${spec}" — packages/ code must not use an app-local "@/" path alias (spec §12 step 0). Use a workspace package specifier instead.`,
        });
        return;
      }

      if (reachesAppsTree(spec)) {
        context.report({
          node: src,
          message: `Cross-tree import banned: "${spec}" — packages/ code must not reach into an apps/* tree (spec §12 step 0). Depend on a workspace package instead.`,
        });
        return;
      }

      if (harness && spec.startsWith("@aws-sdk/")) {
        context.report({
          node: src,
          message: `apps/api/src/harnesses/lib must not import "${spec}" — the harness has no @aws-sdk/* dependency; object storage is injected via the objectStorage HarnessDep (spec §7/§10.1).`,
        });
      }
    };

    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression(node) {
        checkSource(node);
      },
    };
  },
};

const plugin = {
  meta: { name: "ban-cross-tree-imports" },
  rules: { "ban-cross-tree-imports": banCrossTreeImportsRule },
};

export default plugin;
