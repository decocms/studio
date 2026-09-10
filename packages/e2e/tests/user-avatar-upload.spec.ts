/**
 * End-to-end coverage for the per-user filesystem (`/api/_users`) and the
 * profile avatar that is its first consumer.
 *
 * The property under test is the reason the surface exists: an avatar URL must
 * resolve for a caller who is NOT a member of any org the owner belongs to —
 * including a caller with no session at all. An org-scoped URL cannot do that,
 * and a base64 data URL on `user.image` (the thing this replaces) ships inline
 * in every /get-session response and once broke login through the
 * `set-auth-jwt` header.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";
import type { APIRequestContext } from "@playwright/test";

/** Smallest valid PNG — 1×1, transparent. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** A second, distinct PNG so a re-upload lands on a different content hash. */
const PNG_1PX_WHITE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

async function uploadAvatar(
  ctx: APIRequestContext,
  payload: Buffer,
  contentType = "image/png",
) {
  return ctx.post("/api/_users/avatar", {
    headers: { "content-type": contentType },
    data: payload,
  });
}

/** The stored `user.image`, read back through Better Auth. */
async function sessionImage(ctx: APIRequestContext): Promise<string | null> {
  const res = await ctx.get("/api/auth/get-session");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { user?: { image?: string | null } };
  return body.user?.image ?? null;
}

test.describe("user filesystem avatars", () => {
  test("an uploaded avatar is readable with no session at all", async ({
    playwright,
  }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    const upload = await uploadAvatar(owner, PNG_1PX);
    expect(
      upload.ok(),
      `upload failed: HTTP ${upload.status()} — ${await upload.text()}`,
    ).toBe(true);

    const { url } = (await upload.json()) as { url: string };
    expect(url).toContain("/api/_users/fs/");
    expect(url).toContain("path=avatars");

    /** The client persists the URL — Better Auth owns the `image` column. */
    const update = await owner.post("/api/auth/update-user", {
      data: { image: url },
    });
    expect(update.ok()).toBe(true);
    expect(await sessionImage(owner)).toBe(url);

    /** A fresh context has no cookies: a stranger to the user and every org. */
    const stranger = await newApiContext(playwright);
    const read = await stranger.get(url);
    expect(
      read.status(),
      "a published avatar must serve without a session",
    ).toBe(200);
    expect(read.headers()["content-type"]).toContain("image/png");
    expect(Buffer.from(await read.body()).equals(PNG_1PX)).toBe(true);

    await stranger.dispose();
    await owner.dispose();
  });

  test("a member of another org can read it too", async ({ playwright }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);
    const upload = await uploadAvatar(owner, PNG_1PX);
    expect(upload.ok()).toBe(true);
    const { url } = (await upload.json()) as { url: string };

    /** Signed in, no org in common — what an `/api/:org/…` URL would 403 on. */
    const outsider = await newApiContext(playwright);
    await signUpViaApi(outsider);

    const read = await outsider.get(url);
    expect(read.status()).toBe(200);
    expect(Buffer.from(await read.body()).equals(PNG_1PX)).toBe(true);

    await outsider.dispose();
    await owner.dispose();
  });

  test("re-uploading replaces the picture and drops the old bytes", async ({
    playwright,
  }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    const first = await uploadAvatar(owner, PNG_1PX);
    expect(first.ok()).toBe(true);
    const firstUrl = ((await first.json()) as { url: string }).url;

    const second = await uploadAvatar(owner, PNG_1PX_WHITE);
    expect(second.ok()).toBe(true);
    const secondUrl = ((await second.json()) as { url: string }).url;

    expect(secondUrl).not.toBe(firstUrl);

    const stranger = await newApiContext(playwright);
    expect((await stranger.get(secondUrl)).status()).toBe(200);
    expect(
      (await stranger.get(firstUrl)).status(),
      "the superseded avatar must be pruned, not left to accumulate",
    ).toBe(404);

    await stranger.dispose();
    await owner.dispose();
  });

  test("deleting clears the stored bytes", async ({ playwright }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    const upload = await uploadAvatar(owner, PNG_1PX);
    expect(upload.ok()).toBe(true);
    const { url } = (await upload.json()) as { url: string };

    const removed = await owner.delete("/api/_users/avatar");
    expect(removed.ok()).toBe(true);

    const stranger = await newApiContext(playwright);
    expect((await stranger.get(url)).status()).toBe(404);

    await stranger.dispose();
    await owner.dispose();
  });

  test("uploading requires a session", async ({ playwright }) => {
    const anonymous = await newApiContext(playwright);
    const res = await uploadAvatar(anonymous, PNG_1PX);
    expect(res.status()).toBe(401);
    await anonymous.dispose();
  });

  test("SVG is refused — it would be stored XSS on our own origin", async ({
    playwright,
  }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    const res = await uploadAvatar(
      owner,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      "image/svg+xml",
    );
    expect(res.status()).toBe(415);

    await owner.dispose();
  });

  test("an inline data: URL is refused on user.image", async ({
    playwright,
  }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    const res = await owner.post("/api/auth/update-user", {
      data: { image: `data:image/png;base64,${PNG_1PX.toString("base64")}` },
    });
    expect(
      res.status(),
      "inline avatars bloat every session response — the upload route is the only way in",
    ).toBe(400);
    expect(await sessionImage(owner)).toBeNull();

    await owner.dispose();
  });
  test("the profile page uploads through the file input", async ({
    page,
    playwright,
  }) => {
    const owner = await signUpViaApi(page.context().request);
    await page.goto(`/${owner.orgSlug}/settings/profile`);

    await page.locator('input[type="file"]').setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: PNG_1PX,
    });

    const avatar = page.locator('img[src*="/api/_users/fs/"]');
    await expect(avatar).toBeVisible({ timeout: 15_000 });

    /** The rendered src is what a stranger must be able to fetch. */
    const src = await avatar.getAttribute("src");
    expect(src).toBeTruthy();

    const stranger = await newApiContext(playwright);
    expect((await stranger.get(src!)).status()).toBe(200);
    await stranger.dispose();
  });
});
