/**
 * E2E: POST /api/:org/feedback
 *
 * Auth, org membership, validation, and payload limits for general and
 * chat-negative feedback bodies.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

const FEEDBACK_URL = (orgSlug: string) => `/api/${orgSlug}/feedback`;

test.describe("POST /api/:org/feedback", () => {
  test("returns 200 for authenticated org member (general)", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);

    const res = await ctx.post(FEEDBACK_URL(user.orgSlug), {
      data: { message: "E2E general feedback" },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);

    await ctx.dispose();
  });

  test("returns 200 for chat_negative with reasons", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);

    const res = await ctx.post(FEEDBACK_URL(user.orgSlug), {
      data: {
        kind: "chat_negative",
        messageId: "msg-e2e-1",
        threadId: "thread-e2e-1",
        reasons: ["Slow or buggy"],
        details: "optional detail",
      },
    });
    expect(res.status()).toBe(200);

    await ctx.dispose();
  });

  test("returns 400 when message is empty", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);

    const res = await ctx.post(FEEDBACK_URL(user.orgSlug), {
      data: { message: "   " },
    });
    expect(res.status()).toBe(400);

    await ctx.dispose();
  });

  test("returns 400 when chat_negative has no reasons or details", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);

    const res = await ctx.post(FEEDBACK_URL(user.orgSlug), {
      data: { kind: "chat_negative", messageId: "msg-1" },
    });
    expect(res.status()).toBe(400);

    await ctx.dispose();
  });

  test("returns 400 for invalid JSON body", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);

    const res = await ctx.post(FEEDBACK_URL(user.orgSlug), {
      headers: { "Content-Type": "application/json" },
      data: "not-json",
    });
    expect(res.status()).toBe(400);

    await ctx.dispose();
  });

  test("returns 401 when unauthenticated", async ({ playwright }) => {
    const authed = await newApiContext(playwright);
    const user = await signUpViaApi(authed);

    const anon = await newApiContext(playwright);
    const res = await anon.post(FEEDBACK_URL(user.orgSlug), {
      data: { message: "anonymous attempt" },
    });
    expect(res.status()).toBe(401);

    await authed.dispose();
    await anon.dispose();
  });

  test("returns 403 for a principal who is not a member", async ({
    playwright,
  }) => {
    const userACtx = await newApiContext(playwright);
    const userA = await signUpViaApi(userACtx);

    const userBCtx = await newApiContext(playwright);
    await signUpViaApi(userBCtx);

    const res = await userBCtx.post(FEEDBACK_URL(userA.orgSlug), {
      data: { message: "cross-org feedback" },
    });
    expect(res.status()).toBe(403);

    await userACtx.dispose();
    await userBCtx.dispose();
  });

  test("returns 413 when body exceeds limit", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);

    const huge = "x".repeat(70_000);
    const res = await ctx.post(FEEDBACK_URL(user.orgSlug), {
      data: { message: huge },
    });
    expect(res.status()).toBe(413);

    await ctx.dispose();
  });
});

test.describe("feedback UI", () => {
  test("account menu submits general feedback", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}`);

    await page.locator('[data-sidebar="menu-button"]').last().click();
    await page.getByRole("button", { name: "Feedback" }).click();
    await expect(page.getByRole("dialog", { name: "Feedback" })).toBeVisible();

    await page
      .getByPlaceholder(/Tell us about your experience/)
      .fill("E2E UI feedback from account menu");
    await page.getByRole("button", { name: "Send feedback" }).click();

    await expect(page.getByText("Feedback sent — thank you!")).toBeVisible();
  });
});
