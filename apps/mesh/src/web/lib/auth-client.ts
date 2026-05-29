import { createAuthClient } from "better-auth/react";
import {
  organizationClient,
  adminClient,
  magicLinkClient,
  emailOTPClient,
} from "better-auth/client/plugins";
import { ssoClient } from "@better-auth/sso/client";

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
});

type OrgListResult = Awaited<ReturnType<typeof authClient.organization.list>>;

const ORG_LIST_TTL_MS = 30_000;
let orgListCache: { result: OrgListResult; expiresAt: number } | null = null;
let orgListInflight: Promise<OrgListResult> | null = null;

/**
 * `organization.list()` with a short TTL cache + in-flight dedup. Used by the
 * home/onboarding route loaders, which would otherwise each fire a fresh
 * network call on every navigation. Only successful responses are cached so a
 * transient failure isn't pinned for the TTL.
 */
export function listOrganizationsCached(): Promise<OrgListResult> {
  if (orgListCache && orgListCache.expiresAt > Date.now()) {
    return Promise.resolve(orgListCache.result);
  }
  if (orgListInflight) return orgListInflight;
  const inflight = authClient.organization
    .list()
    .then((result: OrgListResult) => {
      if (result.data) {
        orgListCache = { result, expiresAt: Date.now() + ORG_LIST_TTL_MS };
      }
      return result;
    })
    .finally(() => {
      orgListInflight = null;
    });
  orgListInflight = inflight;
  return inflight;
}

/** Drop the cached org list — call after creating/joining/leaving an org. */
export function invalidateOrganizationListCache(): void {
  orgListCache = null;
}
