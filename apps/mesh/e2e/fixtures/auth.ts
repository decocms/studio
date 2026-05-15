import { type Page } from "@playwright/test";

/**
 * Generates a unique test user for each test run.
 * Using a timestamp suffix avoids conflicts between parallel runs or re-runs.
 */
function generateTestUser() {
  const suffix = Date.now();
  return {
    name: `Test User ${suffix}`,
    email: `test-${suffix}@playwright.local`,
    password: "Playwright123!",
  };
}

/**
 * Signs up a new user via the login page form.
 * Returns the user credentials and waits for the home page to load.
 */
export async function signUp(page: Page) {
  const user = generateTestUser();

  await page.goto("/login");

  // Wait for the name input — the form is in sign-up mode by default in a fresh context.
  // The button has aria-hidden when the form is empty, so fill fields first then click.
  await page.getByPlaceholder("Your name").waitFor({ state: "visible" });
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
