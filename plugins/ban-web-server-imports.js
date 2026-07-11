/**
 * Lint plugin enforcing the web ↔ server boundary inside apps/mesh.
 *
 * The frontend (`apps/mesh/src/web/`) ships as a separate build artifact (vite →
 * dist/client, served by the nginx `-web` container) and talks to the API over
 * HTTP via `@decocms/mesh-sdk`. It is therefore free to import *types* from the
 * backend (erased at build — end-to-end type safety is a feature), but must NOT
 * make **value** imports from server-only trees: those pull server runtime code
 * (DB drivers, secrets, provider SDKs) into the browser bundle and couple the UI
 * to the server's internal file layout.
 *
 * Rule: files under `apps/mesh/src/web/` may not make a **value** import (or
 * re-export, or dynamic import) from a `@/<server-tree>/…` specifier. `import
 * type` / `import { type X }` are allowed. The fix is to import it `type`-only,
 * or move the shared value (schema, constant, pure helper) into a frontend-safe
 * location (`@/web`, `@/mcp-apps`, `@/lib`, `@/shared`) or into `@decocms/mesh-sdk`.
 *
 * Companion to `ban-cross-tree-imports.js` (which guards packages/ ↛ apps/mesh)
 * and `ban-e2e-app-imports.js` (which guards the e2e black-box wall).
 */

// Second path segment of `@/<tree>/…` that is server-only. Anything not listed
// (web, mcp-apps, lib, shared, hooks, …) is treated as frontend-safe.
const SERVER_ONLY_TREES = new Set([
  "storage",
  "core",
  "api",
  "tools",
  "auth",
  "services",
  "mcp-clients",
  "event-bus",
  "automations",
  "dispatch-queue",
  "object-storage",
  "file-storage",
  "monitoring",
  "observability",
  "database",
  "dbos",
  "nats",
  "vault",
  "encryption",
  "oauth",
  "link-daemon",
  "harnesses",
  "ai-providers",
  "commerce-discovery",
  "sandbox",
  "settings",
  "links",
]);

function inWebTree(filename) {
  return (
    filename.includes("/apps/mesh/src/web/") ||
    filename.startsWith("apps/mesh/src/web/")
  );
}

// `@/<tree>/…` → returns the server-only tree name, or null.
function serverTreeOf(spec) {
  if (typeof spec !== "string" || !spec.startsWith("@/")) return null;
  const tree = spec.slice(2).split("/")[0];
  return SERVER_ONLY_TREES.has(tree) ? tree : null;
}

// True when the whole statement is type-only (erased at build → safe).
function isTypeOnly(node) {
  const kind = node.importKind ?? node.exportKind;
  if (kind === "type") return true;
  // `import { type A, type B } from …` — value statement, but every named
  // specifier is a type. `export * from` has no specifiers → not type-only.
  const specs = node.specifiers;
  if (Array.isArray(specs) && specs.length > 0) {
    return specs.every(
      (s) => s.importKind === "type" || s.exportKind === "type",
    );
  }
  return false;
}

const banWebServerImportsRule = {
  create(context) {
    const filename = context.filename ?? "";
    if (!inWebTree(filename)) return {};

    const check = (node, { dynamic = false } = {}) => {
      const src = node?.source;
      if (!src || src.type !== "Literal" || typeof src.value !== "string")
        return;
      const tree = serverTreeOf(src.value);
      if (!tree) return;
      if (!dynamic && isTypeOnly(node)) return;

      context.report({
        node: src,
        message:
          `Web ↔ server boundary: "${src.value}" is a VALUE import from the server-only "@/${tree}" tree. ` +
          `The frontend is a separate bundle — it may import types (use \`import type\`) but not runtime code, ` +
          `which risks pulling server deps/secrets into the browser. Move the shared value into @/web, @/mcp-apps, ` +
          `@/lib, @/shared or @decocms/mesh-sdk, or import it type-only.`,
      });
    };

    return {
      ImportDeclaration: (node) => check(node),
      ExportNamedDeclaration: (node) => check(node),
      ExportAllDeclaration: (node) => check(node),
      ImportExpression: (node) => check(node, { dynamic: true }),
    };
  },
};

const plugin = {
  meta: { name: "ban-web-server-imports" },
  rules: { "ban-web-server-imports": banWebServerImportsRule },
};

export default plugin;
