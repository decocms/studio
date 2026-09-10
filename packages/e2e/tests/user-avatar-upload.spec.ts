/**
 * End-to-end coverage for the per-user filesystem (`/api/_users`) and the
 * profile avatars that are its first consumer.
 *
 * Two properties carry this feature. First, the reason the surface exists at
 * all: an avatar URL must resolve for a caller who is NOT a member of any org
 * the owner belongs to — including a caller with no session. An org-scoped URL
 * cannot do that, and a base64 data URL on `user.image` (what this replaces)
 * ships inline in every /get-session response and once broke login through the
 * `set-auth-jwt` header.
 *
 * Second, the privacy line the history draws: past pictures are kept so they
 * can be re-picked, but only the one in use is world-readable. A stranger must
 * see the current avatar and nothing else.
 */

import { deflateSync } from "node:zlib";
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";
import type { APIRequestContext } from "@playwright/test";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * A real 1×1 PNG of the given colour. The server identifies uploads by their
 * leading bytes, so the suite has to send genuine images — and distinct
 * colours give distinct content hashes, which is what separates one stored
 * avatar from another.
 */
function makePng(r: number, g: number, b: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, r, g, b]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Kept in step with `MAX_AVATAR_HISTORY` in `apps/api/src/file-storage/user-fs.ts`. */
const MAX_AVATAR_HISTORY = 5;

const RED = makePng(255, 0, 0);
const GREEN = makePng(0, 255, 0);

interface StoredAvatar {
  path: string;
  url: string;
  current: boolean;
}

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

/** Upload and unwrap the URL, failing loudly on a non-2xx. */
async function uploadOk(
  ctx: APIRequestContext,
  payload: Buffer,
): Promise<string> {
  const res = await uploadAvatar(ctx, payload);
  expect(
    res.ok(),
    `upload failed: HTTP ${res.status()} — ${await res.text()}`,
  ).toBe(true);
  return ((await res.json()) as { url: string }).url;
}

async function listAvatars(ctx: APIRequestContext): Promise<StoredAvatar[]> {
  const res = await ctx.get("/api/_users/avatars");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { avatars: StoredAvatar[] }).avatars;
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

    const url = await uploadOk(owner, RED);
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
    expect(
      read.headers()["x-content-type-options"],
      "the type comes from the extension, so sniffing must be off",
    ).toBe("nosniff");
    expect(Buffer.from(await read.body()).equals(RED)).toBe(true);

    await stranger.dispose();
    await owner.dispose();
  });

  test("a member of another org can read it too", async ({ playwright }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);
    const url = await uploadOk(owner, RED);

    /** Signed in, no org in common — what an `/api/:org/…` URL would 403 on. */
    const outsider = await newApiContext(playwright);
    await signUpViaApi(outsider);

    const read = await outsider.get(url);
    expect(read.status()).toBe(200);
    expect(Buffer.from(await read.body()).equals(RED)).toBe(true);

    await outsider.dispose();
    await owner.dispose();
  });

  test("a replaced picture stays for its owner but stops being public", async ({
    playwright,
  }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    const firstUrl = await uploadOk(owner, RED);
    const secondUrl = await uploadOk(owner, GREEN);
    expect(secondUrl).not.toBe(firstUrl);

    const stranger = await newApiContext(playwright);
    expect((await stranger.get(secondUrl)).status()).toBe(200);
    expect(
      (await stranger.get(firstUrl)).status(),
      "only the picture in use may be world-readable",
    ).toBe(404);

    /** The owner keeps it, which is what makes re-picking possible. */
    const mine = await owner.get(firstUrl);
    expect(mine.status()).toBe(200);
    expect(Buffer.from(await mine.body()).equals(RED)).toBe(true);

    const avatars = await listAvatars(owner);
    expect(avatars).toHaveLength(2);
    expect(avatars.filter((a) => a.current)).toHaveLength(1);

    await stranger.dispose();
    await owner.dispose();
  });

  test("re-picking an old avatar makes it current again", async ({
    playwright,
  }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    const firstUrl = await uploadOk(owner, RED);
    await uploadOk(owner, GREEN);

    const older = (await listAvatars(owner)).find((a) => !a.current);
    expect(older).toBeTruthy();

    const select = await owner.post("/api/_users/avatar/select", {
      data: { path: older!.path },
    });
    expect(select.ok()).toBe(true);
    expect(((await select.json()) as { url: string }).url).toBe(firstUrl);

    const stranger = await newApiContext(playwright);
    expect((await stranger.get(firstUrl)).status()).toBe(200);

    /** Exactly one picture is public at any time. */
    const avatars = await listAvatars(owner);
    expect(avatars.filter((a) => a.current).map((a) => a.path)).toEqual([
      older!.path,
    ]);

    await stranger.dispose();
    await owner.dispose();
  });

  test("the history is capped, dropping the oldest", async ({ playwright }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    const first = await uploadOk(owner, makePng(1, 0, 0));
    for (let i = 2; i <= MAX_AVATAR_HISTORY + 1; i++) {
      await uploadOk(owner, makePng(i, 0, 0));
    }

    const avatars = await listAvatars(owner);
    expect(avatars).toHaveLength(MAX_AVATAR_HISTORY);
    expect(
      avatars.some((a) => a.url === first),
      "the oldest picture should have fallen off the end",
    ).toBe(false);

    await owner.dispose();
  });

  test("deleting one picture leaves the rest alone", async ({ playwright }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    await uploadOk(owner, RED);
    const currentUrl = await uploadOk(owner, GREEN);

    const older = (await listAvatars(owner)).find((a) => !a.current)!;
    const removed = await owner.delete(
      `/api/_users/avatar?path=${encodeURIComponent(older.path)}`,
    );
    expect(removed.ok()).toBe(true);

    const avatars = await listAvatars(owner);
    expect(avatars.map((a) => a.path)).not.toContain(older.path);
    expect(avatars).toHaveLength(1);

    const stranger = await newApiContext(playwright);
    expect((await stranger.get(currentUrl)).status()).toBe(200);

    await stranger.dispose();
    await owner.dispose();
  });

  test("deleting everything clears the stored bytes", async ({
    playwright,
  }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    const url = await uploadOk(owner, RED);
    await uploadOk(owner, GREEN);

    const removed = await owner.delete("/api/_users/avatar");
    expect(removed.ok()).toBe(true);
    expect(await listAvatars(owner)).toHaveLength(0);

    const stranger = await newApiContext(playwright);
    expect((await stranger.get(url)).status()).toBe(404);

    await stranger.dispose();
    await owner.dispose();
  });

  test("uploading requires a session", async ({ playwright }) => {
    const anonymous = await newApiContext(playwright);
    expect((await uploadAvatar(anonymous, RED)).status()).toBe(401);
    expect((await anonymous.get("/api/_users/avatars")).status()).toBe(401);
    await anonymous.dispose();
  });

  test("the bytes decide the type, not the caller's header", async ({
    playwright,
  }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    /** SVG can carry script and these bytes are served to anyone. */
    const svg = await uploadAvatar(
      owner,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      "image/svg+xml",
    );
    expect(svg.status()).toBe(415);

    /** An honest-looking header over dishonest bytes is still refused. */
    const disguised = await uploadAvatar(
      owner,
      Buffer.from("<!doctype html><script>alert(1)</script>"),
      "image/png",
    );
    expect(disguised.status()).toBe(415);

    await owner.dispose();
  });

  test("an inline data: URL is refused on user.image", async ({
    playwright,
  }) => {
    const owner = await newApiContext(playwright);
    await signUpViaApi(owner);

    const res = await owner.post("/api/auth/update-user", {
      data: { image: `data:image/png;base64,${RED.toString("base64")}` },
    });
    expect(
      res.status(),
      "inline avatars bloat every session response — the upload route is the only way in",
    ).toBe(400);
    expect(await sessionImage(owner)).toBeNull();

    await owner.dispose();
  });

  test("the profile page crops and uploads through the dialog", async ({
    page,
    playwright,
  }) => {
    const owner = await signUpViaApi(page.context().request);
    await page.goto(`/${owner.orgSlug}/settings/profile`);

    await page.getByRole("button", { name: "Change your picture" }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: makePng(20, 120, 220),
    });

    /** The crop step, not the upload — nothing is stored until Save. */
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeVisible({ timeout: 15_000 });
    await save.click();

    const avatar = page.locator('img[src*="/api/_users/fs/"]').first();
    await expect(avatar).toBeVisible({ timeout: 20_000 });

    /** The rendered src is what a stranger must be able to fetch. */
    const src = await avatar.getAttribute("src");
    expect(src).toBeTruthy();

    const stranger = await newApiContext(playwright);
    const read = await stranger.get(src!);
    expect(read.status()).toBe(200);
    expect(
      read.headers()["content-type"],
      "the cropper re-encodes to WebP, so the stored extension must follow",
    ).toContain("image/webp");

    await stranger.dispose();
  });
});
