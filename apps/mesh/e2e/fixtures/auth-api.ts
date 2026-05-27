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

export interface SignUpResult {
  name: string;
  email: string;
  password: string;
  userId: string;
  orgSlug: string;
}

function generateTestUser(overrides?: { email?: string; name?: string }) {
  const suffix = Date.now() + Math.floor(Math.random() * 100000);
  return {
    name: overrides?.name ?? `Test User ${suffix}`,
    email: overrides?.email ?? `test-${suffix}@playwright.local`,
    password: "Playwright123!",
  };
}

/**
 * POST /api/auth/sign-up/email and resolve the auto-created org slug.
 *
 * Better Auth's signup hook (apps/mesh/src/auth/index.ts databaseHooks)
 * creates an org synchronously before the response returns, so a follow-up
 * call to organization/list is guaranteed to see it.
 *
 * `request` must be a context that participates in cookie storage — passing
 * `page.context().request` from a spec means the resulting session cookie
 * is already applied to the page that issued the call. Origin is hardcoded
 * because Better Auth's `trustedOrigins` list is keyed off baseUrl, and the
 * Playwright webServer always serves the same origin.
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
  const org = orgs.find((o) => !o.metadata?.archived);
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
