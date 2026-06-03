/**
 * Lint plugin to ban reading `.archived` directly off an org's `.metadata`
 * (e.g. `org.metadata.archived` / `org.metadata?.archived`).
 *
 * Better Auth returns `metadata` as a raw JSON **string** from
 * `organization.list()` / `useListOrganizations()` and as a parsed **object**
 * from `getFullOrganization()`. On the string shape `.archived` is always
 * `undefined`, so a direct read silently passes soft-deleted orgs through.
 * Use `isOrgArchived(org)` from `@/core/org-archived`, which normalizes both
 * shapes. See apps/mesh/src/core/org-archived.ts.
 */

const HELPER_FILENAME = "org-archived";

const banDirectMetadataArchivedRule = {
  create(context) {
    // The helper module is the one place allowed to read the raw flag.
    if (
      context.filename &&
      context.filename.split("/").pop()?.startsWith(HELPER_FILENAME)
    ) {
      return {};
    }

    return {
      // Match `<expr>.metadata.archived` (and the optional-chained variant).
      MemberExpression(node) {
        if (node.property?.type !== "Identifier") return;
        if (node.property.name !== "archived") return;

        const inner = node.object;
        if (inner?.type !== "MemberExpression") return;
        if (inner.property?.type !== "Identifier") return;
        if (inner.property.name !== "metadata") return;

        context.report({
          node,
          message:
            "Reading `.archived` off org metadata directly is banned: Better Auth " +
            "returns metadata as a string from list() and an object from " +
            "getFullOrganization(), so this silently fails on the string shape. " +
            "Use `isOrgArchived(org)` from @/core/org-archived instead.",
        });
      },
    };
  },
};

const plugin = {
  meta: {
    name: "ban-direct-metadata-archived",
  },
  rules: {
    "ban-direct-metadata-archived": banDirectMetadataArchivedRule,
  },
};

export default plugin;
