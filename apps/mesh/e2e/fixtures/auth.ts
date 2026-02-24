import { type Page } from "@playwright/test";

/**
 * Generates a unique test user for each test run.
 * Using a timestamp suffix avoids conflicts between parallel runs or re-runs.
 */
export function generateTestUser() {
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

  // Log all requests and their status to diagnose hangs
  page.on("requestfailed", (req) =>
    console.error("FAILED:", req.url(), req.failure()?.errorText),
  );
  page.on("response", (res) => {
    if (res.url().includes("/api/auth") || res.url().includes("/api/")) {
      console.log("RESPONSE:", res.status(), res.url());
    }
  });

  await page.goto("/login");
  await page.waitForLoadState("domcontentloaded");
  await page.screenshot({ path: "test-results/debug-login.png" });

  // Wait for the form to be ready before doing anything else.
  await page.getByRole("button", { name: "Continue" }).waitFor({ state: "visible" });

  // The form may start in sign-in or sign-up mode depending on localStorage.
  // "Don't have an account? Sign up" is only visible in sign-in mode — click it if present.
  const toggleLink = page.getByText("Don't have an account? Sign up");
  if (await toggleLink.isVisible()) {
    await toggleLink.click();
  }

  // The name field animates in — wait until it's visible and enabled.
  const nameInput = page.getByPlaceholder("Your name");
  await nameInput.waitFor({ state: "visible" });
  await nameInput.fill(user.name);
  await page.getByPlaceholder("you@example.com").fill(user.email);
  await page.getByPlaceholder("••••••••").fill(user.password);
  await page.getByRole("button", { name: "Continue" }).click();

  // Wait for redirect away from /login — org is auto-created on signup
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });

  return user;
}
