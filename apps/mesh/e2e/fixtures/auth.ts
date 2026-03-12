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
  };
}

/**
 * Signs up a new user via the OTP email flow on the login page.
 * Uses a dev-only test endpoint to retrieve the OTP from the database.
 * Returns the user credentials and waits for the home page to load.
 */
export async function signUp(page: Page) {
  const user = generateTestUser();

  await page.goto("/login");

  // Enter email and submit
  await page.getByPlaceholder("you@example.com").waitFor({ state: "visible" });
  await page.getByPlaceholder("you@example.com").fill(user.email);
  await page.getByRole("button", { name: "Continue with email" }).click();

  // Wait for OTP view to appear
  await page.getByPlaceholder("Enter verification code").waitFor({
    state: "visible",
    timeout: 10_000,
  });

  // Retrieve OTP from the dev-only test endpoint
  const baseURL = `http://localhost:${process.env.PORT || "3000"}`;
  const otpResponse = await fetch(
    `${baseURL}/api/auth/custom/test/latest-otp?email=${encodeURIComponent(user.email)}&type=sign-in`,
  );
  const otpData = await otpResponse.json();
  if (!otpData.success || !otpData.otp) {
    throw new Error(`Failed to get OTP: ${otpData.error || "unknown error"}`);
  }

  // Enter OTP and verify
  await page.getByPlaceholder("Enter verification code").fill(otpData.otp);
  await page.getByRole("button", { name: "Verify" }).click();

  // Wait for redirect away from /login — org is auto-created on signup
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });

  return user;
}
