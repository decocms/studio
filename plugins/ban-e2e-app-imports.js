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
// Everything else is denied — in particular the "@/" mesh path alias and any
// reach-in to an app's "src" tree, AND any workspace package NOT on the
// allowlist. The last point is deliberate: app code migrating into packages
// over time must not silently widen the test's surface. Adding a dependency is
// a conscious act — extend BOTH "packages/e2e/package.json" and the allowlist
// here, with justification. Do not silence this rule.
//
// Files outside "packages/e2e/" are not checked.

// Exact bare specifiers that are allowed as-is.
const ALLOWED_EXACT = new Set([
  "@playwright/test",
  "pg",
  "zod",
  "@modelcontextprotocol/sdk",
  "@nats-io/jetstream",
  "@nats-io/transport-node",
  "@nats-io/nats-core",
]);

// Scoped packages allowed at the root or any subpath export (`pkg` / `pkg/sub`).
const ALLOWED_SCOPED = [
  "@modelcontextprotocol/sdk",
  "@decocms/std",
  "@decocms/tunnel",
  "@decocms/sandbox",
  "@decocms/harness",
];

function inE2ePackage(filename) {
  return (
    filename.includes("/packages/e2e/") || filename.startsWith("packages/e2e/")
  );
}
function isAtAlias(spec) {
  return spec.startsWith("@/");
}
function reachesAppSrc(spec) {
  // e.g. "../../../apps/mesh/src/core/org-archived" or "apps/mesh/src/x"
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
      // "../../../apps/mesh/src/x" must still be caught, so these precede the
      // relative-import allow below.
      if (isAtAlias(spec)) {
        context.report({
          node: src,
          message: `e2e isolation: "${spec}" uses the "@/" mesh path alias, which resolves into app source. The e2e suite is a black-box contract — it must not import app source. Inline the expected shape (the test owning its contract is correct, not duplication) or import a published workspace package.`,
        });
        return;
      }

      if (reachesAppSrc(spec)) {
        context.report({
          node: src,
          message: `e2e isolation: "${spec}" reaches into app source (an apps/<name>/src tree). The e2e suite must stay decoupled from the implementation — inline the contract or depend on a published workspace package.`,
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
