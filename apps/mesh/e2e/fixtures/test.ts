/**
 * Extended Playwright `test` with shared fixtures.
 *
 * Specs import from here instead of `@playwright/test` to get:
 *   - `authedPage`: a `page` already carrying a fresh signed-up user's
 *     session cookie + the resolved orgSlug. Use this for everything that
 *     isn't testing the signup flow itself.
 *
 * See TESTING.md for the rules around when to use this vs. the UI signup
 * helper in `auth.ts` (short version: signup/onboarding specs only).
 */

import {
  type APIRequestContext,
  type Page,
  type PlaywrightWorkerArgs,
  test as base,
} from "@playwright/test";
import { signUpViaApi, type SignUpResult } from "./auth-api";

export interface AuthedPage {
  page: Page;
  user: SignUpResult;
  orgSlug: string;
}

interface Fixtures {
  authedPage: AuthedPage;
}

export const test = base.extend<Fixtures>({
  authedPage: async ({ page }, use) => {
    // page.context().request shares cookies with the page, so the session
    // cookie set by sign-up is automatically applied to subsequent
    // page.goto() calls — no manual context.addCookies() round-trip.
    const user = await signUpViaApi(page.context().request);
    await use({ page, user, orgSlug: user.orgSlug });
  },
});

export { expect } from "@playwright/test";

/**
 * Wait for the post-signup redirect off /login. The signup hook
 * auto-creates an org and redirects to `/:slug/...`, but the redirect is
 * client-side and racy with the next test action — every UI signup spec
 * needs to gate on it.
 */
export async function waitForPostSignupRedirect(page: Page): Promise<void> {
  await page.waitForURL(
    (url) => {
      const slug = url.pathname.split("/")[1];
      return !!slug && slug !== "login" && slug !== "api";
    },
    { timeout: 15_000 },
  );
}

/**
 * Create a fresh APIRequestContext with no cookies, bound to the configured
 * baseURL. Use this when a test needs to act as a brand-new principal (e.g.,
 * a second user in the same test) — Playwright's default `request` fixture
 * shares cookies with `page`, which is the wrong scope for multi-user flows.
 *
 * `playwright.request.newContext()` does NOT inherit the project's baseURL,
 * so relative paths like `/api/...` would 404 without this wrapper.
 */
export async function newApiContext(
  playwright: PlaywrightWorkerArgs["playwright"],
): Promise<APIRequestContext> {
  const baseURL = `http://localhost:${process.env.PORT ?? "3000"}`;
  return playwright.request.newContext({ baseURL });
}

/**
 * Pull the org slug out of the current URL. Assumes the page has already
 * landed on `/:slug/...` (call `waitForPostSignupRedirect` first if needed).
 */
export function extractOrgSlugFromUrl(page: Page): string {
  const slug = new URL(page.url()).pathname.split("/")[1];
  if (!slug || slug === "login" || slug === "api") {
    throw new Error(`extractOrgSlugFromUrl: no org slug in URL ${page.url()}`);
  }
  return slug;
}
