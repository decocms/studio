/**
 * Lint plugin enforcing the web ↔ server boundary inside apps/mesh.
 *
 * The frontend (`apps/mesh/src/web/`) ships as a separate build artifact (vite →
 * dist/client, served by the nginx `-web` container) and talks to the API over
 * HTTP via `@decocms/studio-sdk`. It is therefore free to import *types* from the
 * backend (erased at build — end-to-end type safety is a feature), but must NOT
 * make **value** imports from server-only trees: those pull server runtime code
 * (DB drivers, secrets, provider SDKs) into the browser bundle and couple the UI
 * to the server's internal file layout.
 *
 * Rule: files under `apps/mesh/src/web/` may not make a **value** import (or
 * re-export, or dynamic import) that resolves into an `apps/mesh/src/<tree>`
 * OTHER than the frontend-safe trees below. This is an ALLOWLIST — a new
 * server-only tree is guarded by default (fails closed) instead of leaking until
 * someone remembers to blocklist it. `import type` / `import { type X }` are
 * allowed. Both `@/…` alias imports and `../…` relative climbs are checked. The
 * fix is to import it `type`-only, or move the shared value (schema, constant,
 * pure helper) into a frontend-safe tree or into `@decocms/studio-sdk`.
 *
 * Companion to `ban-cross-tree-imports.js` (which guards packages/ ↛ apps/mesh)
 * and `ban-e2e-app-imports.js` (which guards the e2e black-box wall).
 */

// Trees under apps/mesh/src that the browser bundle may value-import from.
// Everything else (storage, core, api, tools, auth, ai-providers, cli, …) is
// server-only by default.
const FRONTEND_SAFE_TREES = new Set(["web", "mcp-apps", "lib", "shared"]);

const SRC_MARKER = "/apps/mesh/src/";

function inWebTree(filename) {
  return (
    filename.includes("/apps/mesh/src/web/") ||
    filename.startsWith("apps/mesh/src/web/")
  );
}

// Test files never ship in the browser bundle, so their imports are outside
// this rule's bundle/secret boundary (a web unit test may pull `@/test` helpers).
function isTestFile(filename) {
  return /\.test\.[cm]?[jt]sx?$/.test(filename);
}

// Resolve `../` / `./` segments of a relative spec against the importing file.
function resolveRelative(fromFile, spec) {
  const parts = fromFile.split("/");
  parts.pop(); // drop the filename → containing directory
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

// Returns the server-only `apps/mesh/src/<tree>` a specifier resolves into, or
// null if it stays in a frontend-safe tree / points outside apps/mesh/src (bare
// or workspace specifier).
function serverTreeOf(spec, filename) {
  if (typeof spec !== "string") return null;
  let resolved;
  if (spec.startsWith("@/")) {
    resolved = `${SRC_MARKER}${spec.slice(2)}`;
  } else if (spec.startsWith(".")) {
    resolved = resolveRelative(filename, spec);
  } else {
    return null; // bare / workspace-package specifier
  }
  const i = resolved.indexOf(SRC_MARKER);
  if (i === -1) return null;
  const tree = resolved.slice(i + SRC_MARKER.length).split("/")[0];
  if (!tree) return null;
  return FRONTEND_SAFE_TREES.has(tree) ? null : tree;
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
    if (!inWebTree(filename) || isTestFile(filename)) return {};

    const check = (node, { dynamic = false } = {}) => {
      const src = node?.source;
      if (!src || src.type !== "Literal" || typeof src.value !== "string")
        return;
      const tree = serverTreeOf(src.value, filename);
      if (!tree) return;
      if (!dynamic && isTypeOnly(node)) return;

      context.report({
        node: src,
        message:
          `Web ↔ server boundary: "${src.value}" is a VALUE import from the server-only "${tree}" tree. ` +
          `The frontend is a separate bundle — it may import types (use \`import type\`) but not runtime code, ` +
          `which risks pulling server deps/secrets into the browser. Move the shared value into @/web, @/mcp-apps, ` +
          `@/lib, @/shared or @decocms/studio-sdk, or import it type-only.`,
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
