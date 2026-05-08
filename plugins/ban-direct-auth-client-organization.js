/**
 * Lint plugin to ban direct use of `authClient.organization.<method>` for
 * org-scoped methods. Those calls must go through `useOrgAuthClient()` so
 * that `organizationId` is injected per-request from the URL/route context
 * instead of falling back to `session.activeOrganizationId` (which leaks
 * across browser tabs — see apps/mesh/src/web/hooks/use-org-auth-client.ts).
 *
 * `setActive` is always banned because it persists the active org to the
 * shared session row.
 *
 * Methods that don't touch a current-org context (list, create,
 * getFullOrganization with explicit query, accept/reject/getInvitation)
 * remain allowed for direct use.
 */

const BANNED_METHODS = new Set([
  "setActive",
  "listMembers",
  "listRoles",
  "inviteMember",
  "removeMember",
  "updateMemberRole",
  "addMember",
  "createRole",
  "updateRole",
  "deleteRole",
  "cancelInvitation",
  "listInvitations",
  "update",
  "delete",
  "getActiveMember",
  "hasPermission",
]);

const WRAPPER_FILENAME = "use-org-auth-client";

const banDirectAuthClientOrganizationRule = {
  create(context) {
    // The wrapper module is the one place that's allowed to call these.
    if (
      context.filename &&
      context.filename.split("/").pop()?.startsWith(WRAPPER_FILENAME)
    ) {
      return {};
    }

    return {
      MemberExpression(node) {
        // Match `authClient.organization.<method>`: the node we're inspecting
        // is the outer MemberExpression with property === <method>.
        if (node.property?.type !== "Identifier") return;
        const methodName = node.property.name;
        if (!BANNED_METHODS.has(methodName)) return;

        const inner = node.object;
        if (inner?.type !== "MemberExpression") return;
        if (inner.property?.type !== "Identifier") return;
        if (inner.property.name !== "organization") return;

        const root = inner.object;
        if (root?.type !== "Identifier") return;
        if (root.name !== "authClient") return;

        context.report({
          node,
          message:
            methodName === "setActive"
              ? "authClient.organization.setActive is banned: it persists the active org to the shared session row, which leaks across browser tabs. Use the URL slug + per-request organizationId instead."
              : `authClient.organization.${methodName} is banned outside use-org-auth-client.ts. Use \`useOrgAuthClient().organization.${methodName}\` so organizationId is injected from the current route context.`,
        });
      },
    };
  },
};

const plugin = {
  meta: {
    name: "ban-direct-auth-client-organization",
  },
  rules: {
    "ban-direct-auth-client-organization": banDirectAuthClientOrganizationRule,
  },
};

export default plugin;
