import { createAuthClient } from "better-auth/react";
import {
  organizationClient,
  adminClient,
  magicLinkClient,
  emailOTPClient,
} from "better-auth/client/plugins";
import { ssoClient } from "@better-auth/sso/client";
import { getCurrentOrgId } from "./org-store";

export const authClient = createAuthClient({
  plugins: [
    organizationClient({
      dynamicAccessControl: {
        enabled: true,
      },
    }),
    adminClient(),
    ssoClient(),
    magicLinkClient(),
    emailOTPClient(),
  ],
  fetchOptions: {
    onRequest: (ctx) => {
      const orgId = getCurrentOrgId();
      if (!orgId) return;

      const urlStr = typeof ctx.url === "string" ? ctx.url : ctx.url.toString();

      // Only intercept organization-management routes.
      // Skip /set-active — those calls carry their own explicit org ID in the
      // body (the org the user is switching TO) and must not be overridden.
      if (!urlStr.includes("/organization/") || urlStr.includes("/set-active"))
        return;

      if (ctx.method?.toUpperCase() === "GET") {
        // Inject as query param — Better Auth reads organizationId from query
        // for listMembers, listRoles, getFullOrganization, etc.
        const url = new URL(urlStr, window.location.origin);
        url.searchParams.set("organizationId", orgId);
        ctx.url = url.toString();
      } else if (
        ctx.body &&
        typeof ctx.body === "object" &&
        !Array.isArray(ctx.body)
      ) {
        // Inject into body — Better Auth reads organizationId from body for
        // inviteMember, removeMember, createRole, updateRole, deleteRole, etc.
        // Only inject if not already explicitly provided by the caller.
        const body = ctx.body as Record<string, unknown>;
        if (!body.organizationId) {
          ctx.body = { ...body, organizationId: orgId };
        }
      }
    },
  },
});
