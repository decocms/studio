import { type Page } from "@playwright/test";

/**
 * Generates a unique test user for each test run.
 * Using a timestamp suffix avoids conflicts between parallel runs or re-runs.
 */
function generateTestUser(overrides?: { email?: string }) {
  const suffix = Date.now() + Math.floor(Math.random() * 1000);
  return {
    name: `Test User ${suffix}`,
    email: overrides?.email ?? `test-${suffix}@playwright.local`,
    password: "Playwright123!",
  };
}

/**
 * Signs up a new user via the login page form.
 * Returns the user credentials and waits for the home page to load.
 * Pass `email` to sign up with a specific address (e.g. to match a pending
 * invitation seeded earlier in the test).
 */
export async function signUp(page: Page, options?: { email?: string }) {
  const user = generateTestUser(options);

  await page.goto("/login");

  // The form remembers its last mode via localStorage and may render as
  // sign-in after cookie wipes; flip to sign-up if the "Your name" field
  // isn't already showing. Single-shot wait so the happy path stays fast.
  const nameField = page.getByPlaceholder("Your name");
  const inSignupMode = await nameField
    .waitFor({ state: "visible", timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (!inSignupMode) {
    await page.getByRole("button", { name: "Sign up" }).click();
    await nameField.waitFor({ state: "visible" });
  }
  await page.getByPlaceholder("Your name").fill(user.name);
  await page.getByPlaceholder("you@example.com").fill(user.email);
  await page.getByPlaceholder("••••••••").fill(user.password);

  // Button becomes aria-visible once canSubmit is true (all fields filled)
  await page.getByRole("button", { name: "Continue" }).click();

  // Wait for redirect away from /login — org is auto-created on signup
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });

  return user;
}
