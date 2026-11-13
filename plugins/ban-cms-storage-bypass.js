/** Keep v8 storage transport inside the CMS module. */
const BLOCK_METHODS = new Set([
  "blocksApply",
  "blocksList",
  "changesList",
  "changesGet",
  "changesDiscard",
]);
const RPC_METHODS = new Set([
  "cms.index",
  "cms.blocks",
  "blocks.apply",
  "blocks.list",
  "changes.list",
  "changes.get",
  "changes.discard",
]);
const PRIVATE_HELPERS = new Set(["cmsUrl", "cmsJson", "cmsDraftRpcEndpoint"]);
const PROTOCOL = "@decocms/blocks/protocol";
const isCmsApi = (source) =>
  typeof source === "string" && /(?:^|\/)cms-api(?:\.ts)?$/.test(source);
const propertyName = (node) =>
  node.computed ? node.property?.value : node.property?.name;
const importedName = (specifier) =>
  specifier.imported?.name ??
  specifier.imported?.value ??
  specifier.local?.name ??
  specifier.local?.value;
const isPrivateImport = (source, name) =>
  (source === PROTOCOL && name === "createContentClient") ||
  (isCmsApi(source) && PRIVATE_HELPERS.has(name));

function hasCmsCall(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "Property") {
    const key = node.key?.name ?? node.key?.value;
    if (key === "method" && RPC_METHODS.has(node.value?.value)) return true;
  }
  // Calls can be nested inside arrays, conditionals and map callbacks.
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value)
        ? value.some(hasCmsCall)
        : value && typeof value === "object" && hasCmsCall(value)),
  );
}

const rule = {
  create(context) {
    const filename = (context.filename ?? "").replaceAll("\\", "/");
    if (
      !filename.includes("apps/web/src/") ||
      filename.includes("apps/web/src/cms/") ||
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename)
    )
      return {};
    const namespaces = new Map();
    const sourceOf = (node) => {
      if (node?.type === "Identifier") return namespaces.get(node.name);
      if (node?.type === "AwaitExpression") return sourceOf(node.argument);
      if (node?.type === "ImportExpression") return node.source?.value;
      return undefined;
    };
    const report = (node) =>
      context.report({
        node,
        message:
          "V8 CMS storage must go through @/cms. Load block bodies before editing; index entries are listing metadata.",
      });
    const checkImports = (node) => {
      const source = node.source?.value;
      for (const spec of node.specifiers ?? []) {
        if (spec.type === "ImportNamespaceSpecifier") {
          namespaces.set(spec.local.name, source);
        } else if (isPrivateImport(source, importedName(spec))) report(spec);
      }
    };
    return {
      ImportDeclaration: checkImports,
      ExportNamedDeclaration: checkImports,
      ExportAllDeclaration(node) {
        if (node.source?.value === PROTOCOL || isCmsApi(node.source?.value))
          report(node);
      },
      MemberExpression(node) {
        const name = propertyName(node);
        const source = sourceOf(node.object);
        if (BLOCK_METHODS.has(name) || isPrivateImport(source, name))
          report(node);
      },
      VariableDeclarator(node) {
        const source = sourceOf(node.init);
        if (node.id?.type === "Identifier" && source) {
          namespaces.set(node.id.name, source);
        }
        if (node.id?.type !== "ObjectPattern") return;
        for (const property of node.id.properties) {
          const name = property.key?.name ?? property.key?.value;
          if (BLOCK_METHODS.has(name) || isPrivateImport(source, name))
            report(property);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee?.type === "MemberExpression" &&
          propertyName(callee) === "batch" &&
          node.arguments.some(hasCmsCall)
        )
          report(node);
      },
      Literal(node) {
        if (typeof node.value === "string" && node.value.includes("/api/cms/"))
          report(node);
      },
      TemplateElement(node) {
        if (node.value?.raw?.includes("/api/cms/")) report(node);
      },
    };
  },
};
export default {
  meta: { name: "ban-cms-storage-bypass" },
  rules: { "ban-cms-storage-bypass": rule },
};
