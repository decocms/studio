import { randomUUID } from "node:crypto";
import { expect, test, getE2EAppOrigin } from "../fixtures/test";
import { signUpViaApi } from "../fixtures/auth-api";

const authJson = (token: string) =>
  JSON.stringify({
    tokens: {
      access_token: token,
      refresh_token: "synthetic-refresh",
      id_token: "synthetic-id",
      account_id: "account_example",
    },
  });

test("settings show quota windows, reset times, and exhausted limits", async ({
  authedPage,
}, testInfo) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const post = (name: string, data: unknown) =>
    api.post(`/api/${orgSlug}/tools/${name}`, { data });
  expect(
    (
      await post("CODEX_SUBSCRIPTION_CONNECT", {
        authJson: authJson(`ok-${randomUUID()}`),
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await post("CLAUDE_SUBSCRIPTION_CONNECT", { token: `ok-${randomUUID()}` })
    ).ok(),
  ).toBe(true);
  await page.goto(`/${orgSlug}/settings/ai-providers`);
  const codex = page.getByRole("group", { name: "ChatGPT for Codex" });
  const claude = page.getByRole("group", { name: "Claude Pro or Max" });
  await expect(codex.getByText("42%", { exact: true })).toBeVisible();
  await expect(codex.getByText("68%", { exact: true })).toBeVisible();
  await expect(codex.getByRole("progressbar", { name: "5h" })).toHaveAttribute(
    "aria-valuenow",
    "42",
  );
  await expect(codex.getByRole("progressbar", { name: "7d" })).toHaveAttribute(
    "aria-valuenow",
    "68",
  );
  await codex.getByRole("progressbar", { name: "5h" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Resets");
  await expect(
    claude.getByText("Limit reached", { exact: true }),
  ).toBeVisible();
  await expect(claude.getByRole("progressbar")).toHaveCount(0);
  await codex.screenshot({
    path: testInfo.outputPath("codex-usage-desktop.png"),
  });
  await claude.screenshot({
    path: testInfo.outputPath("claude-usage-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(codex.getByText("42%", { exact: true })).toBeVisible();
  await codex.screenshot({
    path: testInfo.outputPath("codex-usage-mobile.png"),
  });
  await codex.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  await expect(codex.getByRole("progressbar")).toHaveCount(0);
});

test("personal usage is isolated, sanitized, cached, and handles provider failures", async ({
  authedPage,
  browser,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const post = (name: string, data: unknown) =>
    api.post(`/api/${orgSlug}/tools/${name}`, { data });
  const read = async (provider: string) => {
    const response = await post("SUBSCRIPTION_USAGE_GET", { provider });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  expect(
    (await post("SUBSCRIPTION_USAGE_GET", { provider: "unknown" })).status(),
  ).toBe(400);
  expect((await read("codex")).status).toBe("disconnected");
  const token = `ok-${randomUUID()}`;
  await post("CODEX_SUBSCRIPTION_CONNECT", { authJson: authJson(token) });
  const first = await read("codex");
  expect(first.status).toBe("available");
  expect(JSON.stringify(first)).not.toContain("account_example");
  expect(JSON.stringify(first)).not.toContain("example.test");
  expect(JSON.stringify(first)).not.toContain(token);
  expect(await read("codex")).toEqual(first);
  const count = await api.get(
    `http://127.0.0.1:${process.env.SUBSCRIPTION_USAGE_STUB_PORT || "4105"}/count?token=${token}`,
  );
  expect((await count.json()).count).toBe(1);
  const other = await browser.newContext({ baseURL: getE2EAppOrigin() });
  try {
    const user = await signUpViaApi(other.request);
    const response = await other.request.post(
      `/api/${user.orgSlug}/tools/SUBSCRIPTION_USAGE_GET`,
      { data: { provider: "codex" } },
    );
    expect((await response.json()).status).toBe("disconnected");
  } finally {
    await other.close();
  }
  for (const [prefix, reason] of [
    ["expired", "authorization"],
    ["scope", "permission"],
    ["limited", "rate_limited"],
    ["unavailable", "provider_error"],
    ["malformed", "invalid_response"],
    ["oversized", "invalid_response"],
    ["empty", "no_data"],
  ] as const) {
    await post("CODEX_SUBSCRIPTION_CONNECT", {
      authJson: authJson(`${prefix}-${randomUUID()}`),
    });
    const result = await read("codex");
    expect(result).toMatchObject({
      status: "unavailable",
      reason,
      windows: [],
      limitReached: null,
    });
    expect(JSON.stringify(result)).not.toContain("Synthetic");
    if (prefix === "limited")
      expect(new Date(result.retryAt).getTime()).toBeGreaterThan(Date.now());
  }
  await post("CODEX_SUBSCRIPTION_DISCONNECT", {});
  expect((await read("codex")).status).toBe("disconnected");
});

test("a Claude token without usage permission shows an explanation and provider link", async ({
  authedPage,
}, testInfo) => {
  const { page, orgSlug } = authedPage;
  await page
    .context()
    .request.post(`/api/${orgSlug}/tools/CLAUDE_SUBSCRIPTION_CONNECT`, {
      data: { token: `scope-${randomUUID()}` },
    });
  await page.goto(`/${orgSlug}/settings/ai-providers`);
  const row = page.getByRole("group", { name: "Claude Pro or Max" });
  await row.getByText("Usage unavailable", { exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "This token cannot read usage limits",
  );
  await expect(row.getByRole("progressbar")).toHaveCount(0);
  await row.screenshot({
    path: testInfo.outputPath("claude-usage-unavailable.png"),
  });
  await row.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "View on provider" }),
  ).toHaveAttribute("href", "https://claude.ai/settings/usage");
});
