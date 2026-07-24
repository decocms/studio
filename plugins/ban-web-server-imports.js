/**
 * Lint plugin enforcing the apps/web ↛ apps/api source boundary.
 *
 * The frontend (`apps/web`) and backend (`apps/api`) are independent workspace
 * applications and build artifacts. Browser code talks to the API over HTTP via
 * browser-safe clients in `@decocms/shared/sdk/*`; it must never depend on the
 * API's internal file layout.
 *
 * Rule: files under `apps/web/src/` may not import, re-export, or dynamically
 * import anything under `apps/api/src/`. This includes type-only imports: shared
 * wire contracts belong in explicit `@decocms/shared/*` domain subpaths, not
 * either app tree. React hooks and context remain app-local under `apps/web`.
 * App-local `@/` imports remain valid because the web tsconfig resolves them
 * within `apps/web/src`.
 *
 * Companion to `ban-cross-tree-imports.js` (which guards packages/ ↛ apps/*)
 * and `ban-e2e-app-imports.js` (which guards the e2e black-box wall).
 */

const API_SRC_MARKER = "/apps/api/src/";

function inWebTree(filename) {
  return (
    filename.includes("/apps/web/src/") || filename.startsWith("apps/web/src/")
  );
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

function reachesApiSource(spec, filename) {
  if (typeof spec !== "string") return false;
  const resolved = spec.startsWith(".")
    ? resolveRelative(filename, spec)
    : spec;
  return (
    resolved === "apps/api/src" ||
    resolved.startsWith("apps/api/src/") ||
    resolved.includes(API_SRC_MARKER)
  );
}

const banWebServerImportsRule = {
  create(context) {
    const filename = context.filename ?? "";
    if (!inWebTree(filename)) return {};

    const check = (node) => {
      const src = node?.source;
      if (!src || src.type !== "Literal" || typeof src.value !== "string") {
        return;
      }
      if (!reachesApiSource(src.value, filename)) return;

      context.report({
        node: src,
        message:
          `Web ↔ API boundary: "${src.value}" reaches into apps/api/src. ` +
          "The frontend is a separate workspace and may not import API implementation, even type-only. " +
          "Move isomorphic contracts or browser-safe runtime helpers to an explicit @decocms/shared/* " +
          "subpath, or keep React and other app-specific code app-local.",
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
  meta: { name: "ban-web-server-imports" },
  rules: { "ban-web-server-imports": banWebServerImportsRule },
};

export default plugin;
