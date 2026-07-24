/**
 * API-driven signup for tests that don't care about the signup UI.
 *
 * The UI helper in `auth.ts` exists because some specs ARE testing the
 * signup/onboarding flow — they need to drive the real form. For every
 * other spec, going through the form just burns wall time on a flow that
 * isn't under test. This module hits Better Auth's HTTP endpoints directly.
 *
 * Cookies set by sign-up persist on the `APIRequestContext` you pass in
 * (Playwright threads them through to the browser when you reuse the same
 * context — see `fixtures/test.ts` for the wiring).
 */

import type { APIRequestContext } from "@playwright/test";

/**
 * Inlined contract: an org is archived when its `metadata.archived === true`.
 * Owned here (not imported from app source) so the black-box suite stays
 * decoupled — see `@decocms/shared/organization/org-archived`.
 */
function isOrgArchived(
  org: { metadata?: unknown } | null | undefined,
): boolean {
  const raw = org?.metadata;
  if (!raw) return false;
  try {
    const meta =
      typeof raw === "string"
        ? (JSON.parse(raw) as { archived?: boolean })
        : (raw as { archived?: boolean });
    return meta.archived === true;
  } catch {
    return false;
  }
}

export interface SignUpResult {
  name: string;
  email: string;
  password: string;
  userId: string;
  orgSlug: string;
}

/** Every test principal shares this password. Exported so specs that sign an
 *  existing fixed identity back in (e.g. deployment-admin.spec.ts under
 *  `reuseExistingServer` reruns) can't drift from what sign-up used. */
export const TEST_PASSWORD = "Playwright123!";

function generateTestUser(overrides?: { email?: string; name?: string }) {
  const suffix = Date.now() + Math.floor(Math.random() * 100000);
  // The unique suffix must lead the name: the signup hook derives the default
  // org slug from the first name only, so a shared "Test" first name would
  // collapse every test org into a tiny shared slug namespace and collide.
  return {
    name: overrides?.name ?? `T${suffix} User`,
    email: overrides?.email ?? `test-${suffix}@playwright.local`,
    password: TEST_PASSWORD,
  };
}

/**
 * POST /api/auth/sign-up/email and resolve the auto-created org slug.
 *
 * Better Auth's signup hook (`apps/api/src/auth/index.ts` databaseHooks)
 * creates an org synchronously before the response returns, so a follow-up
 * call to organization/list is guaranteed to see it.
 *
 * `request` must be a context that participates in cookie storage — passing
 * `page.context().request` from a spec means the resulting session cookie
 * is already applied to the page that issued the call. Standalone API
 * contexts must use `newApiContext()` from `fixtures/test.ts` so their Origin
 * header matches Better Auth's `trustedOrigins`.
 */
export async function signUpViaApi(
  request: APIRequestContext,
  options?: { email?: string; name?: string },
): Promise<SignUpResult> {
  const user = generateTestUser(options);

  const signupRes = await request.post("/api/auth/sign-up/email", {
    data: {
      email: user.email,
      password: user.password,
      name: user.name,
    },
  });
  if (!signupRes.ok()) {
    const body = await signupRes.text().catch(() => "<unreadable>");
    throw new Error(
      `signUpViaApi: POST /api/auth/sign-up/email → HTTP ${signupRes.status()} — ${body}`,
    );
  }
  const signupBody = (await signupRes.json()) as {
    user?: { id?: string };
  };
  const userId = signupBody.user?.id;
  if (!userId) {
    throw new Error(
      `signUpViaApi: response did not include user.id (got ${JSON.stringify(signupBody)})`,
    );
  }

  // Better Auth's organization plugin lists orgs the session principal
  // belongs to. The signup hook auto-creates exactly one, so we pick the
  // first non-archived entry.
  const listRes = await request.get("/api/auth/organization/list");
  if (!listRes.ok()) {
    const body = await listRes.text().catch(() => "<unreadable>");
    throw new Error(
      `signUpViaApi: GET /api/auth/organization/list → HTTP ${listRes.status()} — ${body}`,
    );
  }
  const orgsBody = (await listRes.json()) as
    | Array<{ slug: string; metadata?: { archived?: boolean } | null }>
    | {
        data?: Array<{
          slug: string;
          metadata?: { archived?: boolean } | null;
        }>;
      };
  // Better Auth has shipped both shapes over time. Accept either.
  const orgs = Array.isArray(orgsBody) ? orgsBody : (orgsBody.data ?? []);
  const org = orgs.find((o) => !isOrgArchived(o));
  if (!org) {
    throw new Error(
      `signUpViaApi: signup completed but no org was found for user ${userId}`,
    );
  }

  return {
    name: user.name,
    email: user.email,
    password: user.password,
    userId,
    orgSlug: org.slug,
  };
}
