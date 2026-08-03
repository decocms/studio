import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

// The report chrome renders in the viewer's language (defaulted from
// navigator.language), so the copy asserted below only holds under an English
// locale. Pin it rather than inherit the runner's.
test.use({ locale: "en-US" });

test("anonymous shared report shows login over a blurred preview", async ({
  page,
}) => {
  await page.goto(
    "/report/example.com?share_id=example%3Aslide%3Atest&utm_source=share#overview",
  );

  const dialog = page.getByRole("dialog", { name: "Access your report" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Already received by")).toBeVisible();

  const preview = page.locator('div[aria-hidden="true"]').filter({
    hasText: "A complete view of your store and where to grow first.",
  });
  await expect(preview).toHaveCSS("filter", "blur(9px)");
  await expect(page).toHaveURL(/share_id=example%3Aslide%3Atest/);
  await expect(page).toHaveURL(/#overview$/);
});

test("scan operations reject anonymous callers, but reading a report doesn't", async ({
  playwright,
}) => {
  const anonymous = await newApiContext(playwright);
  const gated = await Promise.all([
    anonymous.post("/api/_reports/run", {
      data: { domain: "example.com", email: "other@example.com" },
    }),
    anonymous.get("/api/_reports/status?id=run-id"),
    anonymous.get("/api/_reports/link-token/token-id"),
    anonymous.get("/api/_reports/suggest?q=e"),
  ]);
  for (const response of gated) {
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
  }

  // GET /site is the one route anonymous callers can reach — it's how the
  // cover slide of an already-completed scan shows before login. There's no
  // completed scan for this domain, so it comes back "not_found", not a 401.
  const site = await anonymous.get("/api/_reports/site/example.com");
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

  await expect(
    page.getByRole("dialog", { name: "Access your report" }),
  ).toBeVisible();
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
