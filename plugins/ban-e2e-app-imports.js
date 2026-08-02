// Lint plugin enforcing e2e-suite isolation (deny-by-default).
//
// The e2e suite is a BLACK-BOX CONTRACT over HTTP + DB: spin the server, hit it
// over the wire, assert on responses. It must stay decoupled from the
// implementation so the app can be rewritten (even in another language) and the
// same suite still holds. To keep that true over time, files under
// "packages/e2e/" may import ONLY:
//
//   - relative specifiers (intra-package fixtures/pages/specs),
//   - "node:" builtins,
//   - the explicit ALLOWLIST below (runner + DB + MCP test client + the
//     wire-protocol packages a fake daemon needs).
//
// Everything else is denied — in particular any app-local "@/" alias and any
// reach-in to an app's "src" tree, AND any workspace package NOT on the
// allowlist. The last point is deliberate: app code migrating into packages
// over time must not silently widen the test's surface. Adding a dependency is
// a conscious act — extend BOTH "packages/e2e/package.json" and the allowlist
// here, with justification. Do not silence this rule.
//
// Files outside "packages/e2e/" are not checked.

// Exact bare specifiers that are allowed as-is.
const ALLOWED_EXACT = new Set(["@playwright/test", "pg", "zod"]);

// Scoped packages allowed at the root or any subpath export (`pkg` / `pkg/sub`).
const ALLOWED_SCOPED = ["@modelcontextprotocol/sdk", "@decocms/shared"];

function inE2ePackage(filename) {
  return (
    filename.includes("/packages/e2e/") || filename.startsWith("packages/e2e/")
  );
}
function isAtAlias(spec) {
  return spec.startsWith("@/");
}
function reachesAppSrc(spec) {
  // e.g. "../../../apps/api/src/core/org-archived" or "apps/web/src/x"
  return /(^|\/)apps\/[^/]+\/src(\/|$)/.test(spec);
}
function isAllowed(spec) {
  if (ALLOWED_EXACT.has(spec)) return true;
  return ALLOWED_SCOPED.some((s) => spec === s || spec.startsWith(`${s}/`));
}

const banE2eAppImportsRule = {
  create(context) {
    const filename = context.filename ?? "";
    if (!inE2ePackage(filename)) return {};

    const checkSource = (node) => {
      const src = node?.source;
      if (!src || src.type !== "Literal" || typeof src.value !== "string") {
        return;
      }
      const spec = src.value;

      // Reach-ins are checked first — a RELATIVE specifier like
      // "../../../apps/api/src/x" must still be caught, so these precede the
      // relative-import allow below.
      if (isAtAlias(spec)) {
        context.report({
          node: src,
          message: `e2e isolation: "${spec}" uses an app-local "@/" path alias. The e2e suite is a black-box contract — it must not import app source. Inline the expected shape (the test owning its contract is correct, not duplication) or import an allowlisted workspace package.`,
        });
        return;
      }

      if (reachesAppSrc(spec)) {
        context.report({
          node: src,
          message: `e2e isolation: "${spec}" reaches into app source (an apps/<name>/src tree). The e2e suite must stay decoupled from the implementation — inline the contract or depend on an allowlisted workspace package.`,
        });
        return;
      }

      if (spec.startsWith(".") || spec.startsWith("node:")) return;

      if (isAllowed(spec)) return;

      context.report({
        node: src,
        message: `e2e isolation: "${spec}" is not on the allowlist (deny-by-default). Allowed: relative imports, node:*, and ${[
          ...ALLOWED_EXACT,
          ...ALLOWED_SCOPED.filter((s) => !ALLOWED_EXACT.has(s)),
        ].join(
          ", ",
        )}. To add one, extend BOTH packages/e2e/package.json and the allowlist in plugins/ban-e2e-app-imports.js with justification — do not silence this rule.`,
      });
    };

    // Known gap: a type-position `import("../../apps/api/src/...").Foo`
    // (TSImportType) is NOT caught — oxlint's experimental JS-plugin traversal
    // doesn't dispatch named visitors for TS type nodes (verified against
    // oxlint 1.23.0). The risk is low: a type-only import is erased at runtime
    // and creates no dependency, and the alias forms (`@/`, `@deco/*`) ARE
    // caught by tsc (paths:{}). Revisit if oxlint adds type-node visitors.
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
  meta: { name: "ban-e2e-app-imports" },
  rules: { "ban-e2e-app-imports": banE2eAppImportsRule },
};

export default plugin;
