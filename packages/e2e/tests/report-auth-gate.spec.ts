import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

// The report chrome renders in the viewer's language (defaulted from
// navigator.language), so the copy asserted below only holds under an English
// locale. Pin it rather than inherit the runner's.
test.use({ locale: "en-US" });

test("an anonymous visitor's scan starts without a login wall", async ({
  page,
}) => {
  const domain = `anon-visitor-${crypto.randomUUID()}.example`;
  await page.goto(
    `/report/${domain}?share_id=example%3Aslide%3Atest&utm_source=share#overview`,
  );

  // No completed scan and no session ⇒ the scan screen, not the login gate.
  await expect(page.getByText("Analysis started")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in to get notified" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Access your report" }),
  ).toHaveCount(0);

  await expect(page).toHaveURL(/share_id=example%3Aslide%3Atest/);
  await expect(page).toHaveURL(/#overview$/);
});

test("anonymous callers can start and follow a scan, with no delivery address", async ({
  playwright,
}) => {
  const anonymous = await newApiContext(playwright);
  const domain = `anon-run-${crypto.randomUUID()}.example`;

  const run = await anonymous.post("/api/_reports/run", {
    data: { domain, email: "attacker-controlled@example.com" },
  });
  expect(run.status()).toBe(200);

  const commerceMock = await playwright.request.newContext({
    baseURL: `http://localhost:${process.env.COMMERCE_MOCK_PORT ?? "4100"}`,
  });
  const captured = (await (
    await commerceMock.get(
      `/__e2e/report-run?domain=${encodeURIComponent(domain)}`,
    )
  ).json()) as { url?: string; email?: string };
  expect(captured.url).toBe(domain);
  // Sessionless run ⇒ no notification address, least of all the caller's.
  expect(captured.email).toBeUndefined();
  await commerceMock.dispose();

  // Polling is open too — 400 (missing id) proves the 401 gate is gone.
  const status = await anonymous.get("/api/_reports/status");
  expect(status.status()).toBe(400);

  // Still session-only: anything tied to a person.
  const gated = await Promise.all([
    anonymous.get("/api/_reports/link-token/token-id"),
    anonymous.get("/api/_reports/suggest?q=e"),
  ]);
  for (const response of gated) {
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
  }

  // Reading is open, but a never-scanned domain has nothing to read.
  const site = await anonymous.get(
    `/api/_reports/site/${encodeURIComponent(domain)}`,
  );
  expect(site.status()).toBe(200);
  expect(site.headers()["cache-control"]).toContain("no-store");
  expect((await site.json()).status).toBe("not_found");

  await anonymous.dispose();
});

test("a Studio session unlocks the report API", async ({ playwright }) => {
  const authenticated = await newApiContext(playwright);
  await signUpViaApi(authenticated);

  // A one-character query returns locally before the reports engine is called,
  // so this pins session acceptance without depending on an external service.
  const response = await authenticated.get("/api/_reports/suggest?q=e");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ suggestions: [] });
  expect(response.headers()["cache-control"]).toContain("no-store");

  await authenticated.dispose();
});

test("an expired report session returns to the inline login", async ({
  page,
}) => {
  await signUpViaApi(page.context().request);
  await page.route("**/api/_reports/site/**", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Authentication required" }),
    }),
  );

  await page.goto("/report/session-expired.example");

  const dialog = page.getByRole("dialog", { name: "Access your report" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Already received by")).toBeVisible();

  const preview = page.locator('div[aria-hidden="true"]').filter({
    hasText: "A complete view of your store and where to grow first.",
  });
  await expect(preview).toHaveCSS("filter", "blur(9px)");
});

test("a failed initial read never triggers a scan", async ({ page }) => {
  await signUpViaApi(page.context().request);
  let scanRequests = 0;
  await page.route("**/api/_reports/site/**", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "report read failed" }),
    }),
  );
  await page.route("**/api/_reports/run", (route) => {
    scanRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ state: "fresh" }),
    });
  });

  await page.goto("/report/read-error.example");

  await expect(
    page.getByRole("alert", { name: "Couldn't load the report" }),
  ).toBeVisible();
  expect(scanRequests).toBe(0);
});

test("an authenticated scan uses the session email", async ({ playwright }) => {
  const authenticated = await newApiContext(playwright);
  const user = await signUpViaApi(authenticated);
  const domain = `session-email-${crypto.randomUUID()}.example`;

  const response = await authenticated.post("/api/_reports/run", {
    data: {
      domain,
      email: "attacker-controlled@example.com",
    },
  });
  expect(response.status()).toBe(200);

  const commerceMock = await playwright.request.newContext({
    baseURL: `http://localhost:${process.env.COMMERCE_MOCK_PORT ?? "4100"}`,
  });
  const capturedResponse = await commerceMock.get(
    `/__e2e/report-run?domain=${encodeURIComponent(domain)}`,
  );
  expect(capturedResponse.status()).toBe(200);
  const captured = (await capturedResponse.json()) as {
    url?: string;
    email?: string;
  };
  expect(captured).toMatchObject({
    url: domain,
    email: user.email,
  });
  expect(captured.email).not.toBe("attacker-controlled@example.com");

  await commerceMock.dispose();
  await authenticated.dispose();
});
