/**
 * useOrgAuthClient
 *
 * Wraps `authClient.organization` and injects `organizationId` from the
 * current project context into every org-scoped call.
 *
 * Why: Better Auth's organization plugin endpoints fall back to
 * `session.activeOrganizationId` when no `organizationId` is passed. That
 * field lives on a single per-user session row shared across all browser
 * tabs, so calls from tab A could silently hit tab B's org. The fix —
 * recommended by Better Auth's docs — is to manage the active org
 * client-side and pass `organizationId` per-request. This hook is the
 * single place where that injection happens.
 *
 * Direct use of `authClient.organization.<method>` for org-scoped methods
 * is banned by the `ban-direct-auth-client-organization` lint rule. New
 * code should call methods on the object returned by this hook.
 */

import { authClient } from "@/web/lib/auth-client";
import { useProjectContext } from "@decocms/mesh-sdk";

type OrgClient = typeof authClient.organization;

type Params<K extends keyof OrgClient> = OrgClient[K] extends (
  args: infer A,
  ...rest: unknown[]
) => unknown
  ? A
  : never;

type Result<K extends keyof OrgClient> = OrgClient[K] extends (
  ...args: unknown[]
) => infer R
  ? R
  : never;

export function useOrgAuthClient() {
  const { org } = useProjectContext();
  const organizationId = org.id;

  // Methods where `organizationId` is a top-level field on the body.
  const withBodyOrgId = <K extends keyof OrgClient>(method: K) => {
    return ((args?: Params<K>) =>
      (authClient.organization[method] as (a: unknown) => Result<K>)({
        ...(args ?? {}),
        organizationId,
      })) as (args?: Params<K>) => Result<K>;
  };

  // Methods where `organizationId` lives under `query`.
  const withQueryOrgId = <K extends keyof OrgClient>(method: K) => {
    return ((args?: Params<K>) => {
      const next = { ...(args ?? {}) } as Record<string, unknown>;
      const query = (next.query as Record<string, unknown> | undefined) ?? {};
      next.query = { ...query, organizationId };
      return (authClient.organization[method] as (a: unknown) => Result<K>)(
        next,
      );
    }) as (args?: Params<K>) => Result<K>;
  };

  return {
    organization: {
      // ---- org-scoped (orgId injected) ----
      listMembers: withQueryOrgId("listMembers"),
      listRoles: withQueryOrgId("listRoles"),
      inviteMember: withBodyOrgId("inviteMember"),
      removeMember: withBodyOrgId("removeMember"),
      updateMemberRole: withBodyOrgId("updateMemberRole"),
      addMember: withBodyOrgId("addMember"),
      createRole: withBodyOrgId("createRole"),
      updateRole: withBodyOrgId("updateRole"),
      deleteRole: withBodyOrgId("deleteRole"),
      cancelInvitation: withBodyOrgId("cancelInvitation"),
      update: withBodyOrgId("update"),

      // ---- non-org-scoped pass-throughs ----
      // Invitations are scoped by their own id.
      acceptInvitation: authClient.organization.acceptInvitation,
      rejectInvitation: authClient.organization.rejectInvitation,
      getInvitation: authClient.organization.getInvitation,
      // Cross-org or pre-org operations.
      list: authClient.organization.list,
      create: authClient.organization.create,
      getFullOrganization: authClient.organization.getFullOrganization,
    },
  };
}
