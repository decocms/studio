import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

test("report data and scan operations reject anonymous callers", async ({
  playwright,
}) => {
  const anonymous = await newApiContext(playwright);
  const responses = await Promise.all([
    anonymous.get("/api/_reports/site/example.com"),
    anonymous.post("/api/_reports/run", {
      data: { domain: "example.com", email: "other@example.com" },
    }),
    anonymous.get("/api/_reports/status?id=run-id"),
    anonymous.get("/api/_reports/link-token/token-id"),
    anonymous.get("/api/_reports/suggest?q=e"),
  ]);

  for (const response of responses) {
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
  }

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
