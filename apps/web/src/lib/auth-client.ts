import { createAuthClient } from "better-auth/react";
import {
  organizationClient,
  adminClient,
  magicLinkClient,
  emailOTPClient,
} from "better-auth/client/plugins";
import { ssoClient } from "@better-auth/sso/client";
import * as z from "zod";
import { activeOrganizations } from "@decocms/shared/organization/org-archived";

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

/**
 * Resolve once better-auth's session store has settled, signed in or out.
 *
 * `authClient.getSession()` is deliberately NOT used: it issues its own request
 * and leaves the `useSession` store untouched, so the store would still report
 * `isPending` on the shell's first render — the state that used to paint a
 * second splash. Subscribing is what starts the store's fetch, so this settles
 * it and brings it forward at the same time. The subscription is never torn
 * down: it is one listener for the life of the page, and dropping it would let
 * nanostores unmount the atom and take better-auth's session refresh manager
 * with it.
 *
 * Shared by the boot gate and the org route's loader, so it is one listener
 * however many callers wait on it.
 *
 * It also FAILS OPEN. `isPending` only clears from better-auth's own
 * success/error paths, and its fetch carries no timeout — so a request that
 * opens a socket and is never answered (a captive portal, a black-holed proxy)
 * left this promise unresolved forever. That mattered more here than at the
 * five boundaries this replaced: they each failed open with the router already
 * mounted, whereas the boot gate sits ABOVE `<RouterProvider>`, so the same hang
 * meant an infinite splash with no route tree, no error boundary and `/login`
 * unreachable. After the deadline the app mounts with the session still
 * pending, which `RequiredAuthLayout` renders as a loader rather than a blank.
 */
const SESSION_SETTLE_TIMEOUT_MS = 8_000;

let sessionSettledPromise: Promise<void> | undefined;

export function sessionSettled(): Promise<void> {
  sessionSettledPromise ??= new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SESSION_SETTLE_TIMEOUT_MS);
    authClient.$store.listen("session", (state: unknown) => {
      if (state && typeof state === "object" && "isPending" in state) {
        if (!state.isPending) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });
  return sessionSettledPromise;
}

const sessionUserSchema = z.object({
  data: z.object({ user: z.object({ id: z.string() }) }).nullish(),
});

/** The signed-in user's id as the session store holds it right now. */
export function currentSessionUserId(): string | undefined {
  const parsed = sessionUserSchema.safeParse(
    authClient.$store.atoms.session?.get(),
  );
  return parsed.success ? parsed.data.data?.user.id : undefined;
}

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
    .then((raw: OrgListResult) => {
      // Choke point: every caller of this helper gets active orgs, once each.
      const result: OrgListResult = raw.data
        ? { ...raw, data: activeOrganizations(raw.data) }
        : raw;
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

/**
 * Reactive org list with archived orgs filtered out and each org once — the
 * blessed UI hook. Use this instead of `authClient.useListOrganizations()`
 * directly so archived or duplicated orgs never leak into a list surface.
 */
export function useActiveOrganizations() {
  const result = authClient.useListOrganizations();
  const data = result.data ? activeOrganizations(result.data) : undefined;
  return { ...result, data };
}

/** Drop the cached org list — call after creating/joining/leaving an org. */
export function invalidateOrganizationListCache(): void {
  orgListCache = null;
}
