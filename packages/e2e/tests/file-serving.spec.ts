/**
 * End-to-end coverage for the stable file-serving route
 * (`GET /api/:org/files/*`), which proxies object bytes through studio instead
 * of 302-redirecting to a presigned S3 URL.
 *
 * The route has two byte-delivery paths and this spec exercises both depending
 * on how the running app is configured (see e2e.yml):
 *   - **dev (no S3):** DevObjectStorage hands back a `data:` URL → studio decodes
 *     it and serves the bytes inline.
 *   - **S3 (CI MinIO):** studio presigns a GET internally, fetches it, and streams
 *     the body back — the signed URL / storage origin never reach the client.
 *
 * Bytes-back, content-type, CSP and auth assertions run in BOTH backends so the
 * suite is meaningful on a plain `bun run test:e2e`. Range/conditional
 * passthrough and the upstream-404→404 mapping are proxy-only behaviors, so
 * they're gated behind a real S3 backend.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";
import type { APIRequestContext } from "@playwright/test";

const s3Configured = !!(
  process.env.S3_ENDPOINT &&
  process.env.S3_BUCKET &&
  process.env.S3_ACCESS_KEY_ID &&
  process.env.S3_SECRET_ACCESS_KEY
);

const uniqueKey = (ext: string) =>
  `e2e-files/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

/**
 * Upload bytes to the org's storage via a presigned PUT URL. Works on both
 * backends: S3 signs the content-type into the URL (so the PUT must replay it
 * verbatim), and the dev backend ignores it — replaying it is harmless either
 * way.
 */
async function uploadObject(
  ctx: APIRequestContext,
  orgSlug: string,
  key: string,
  contentType: string,
  payload: Buffer,
): Promise<void> {
  const put = await callSelfMcpTool<{ url: string }>(
    ctx,
    orgSlug,
    "PUT_PRESIGNED_URL",
    { key, contentType },
  );
  const res = await ctx.fetch(put.url, {
    method: "PUT",
    data: payload,
    headers: { "content-type": contentType },
  });
  expect(
    res.ok(),
    `upload failed: HTTP ${res.status()} — ${await res
      .text()
      .catch(() => "<unreadable>")}`,
  ).toBe(true);
}

test.describe("File serving (/api/:org/files/*)", () => {
  test("serves object bytes directly instead of redirecting", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);

    const key = uniqueKey("png");
    // A clearly-binary payload (PNG magic + junk) so the dev backend's
    // base64 data:-URL round-trip is exercised, not just the text path.
    const payload = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`e2e-bytes-${key}`),
    ]);
    await uploadObject(ctx, orgSlug, key, "image/png", payload);

    // maxRedirects: 0 is the regression guard — a 302 back to a presigned S3
    // URL (the old behavior) would surface here as status 302, not 200.
    const res = await ctx.get(`/api/${orgSlug}/files/${key}`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    expect(res.headers()["cache-control"]).toContain("private");
    const body = await res.body();
    expect(body.equals(payload)).toBe(true);

    await ctx.dispose();
  });

  test("sandboxes member-authored HTML served same-origin", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);

    const key = uniqueKey("html");
    const html = Buffer.from(
      "<!doctype html><title>e2e</title><p>hello</p>",
      "utf-8",
    );
    await uploadObject(ctx, orgSlug, key, "text/html", html);

    const res = await ctx.get(`/api/${orgSlug}/files/${key}`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
    // Now that HTML is served from studio's own origin (not the storage origin
    // after a redirect), it must run with an opaque origin so its scripts
    // can't make credentialed same-origin calls.
    expect(res.headers()["content-security-policy"]).toContain("sandbox");
    expect((await res.body()).equals(html)).toBe(true);

    await ctx.dispose();
  });

  test("rejects unauthenticated API clients with 401", async ({
    playwright,
  }) => {
    // A valid org slug (so org resolution doesn't 404), hit by a fresh context
    // carrying no session cookie. The auth check fires before any storage
    // lookup, so the key need not exist.
    const owner = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(owner);

    const anon = await newApiContext(playwright);
    const res = await anon.get(`/api/${orgSlug}/files/${uniqueKey("txt")}`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(401);

    await anon.dispose();
    await owner.dispose();
  });

  test.describe("proxy-only behavior (real S3)", () => {
    test.skip(
      !s3Configured,
      "requires S3 env (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY); the dev backend serves bytes inline without proxying",
    );

    test("forwards Range requests and returns 206 Partial Content", async ({
      playwright,
    }) => {
      const ctx = await newApiContext(playwright);
      const { orgSlug } = await signUpViaApi(ctx);

      const key = uniqueKey("bin");
      const payload = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
      await uploadObject(
        ctx,
        orgSlug,
        key,
        "application/octet-stream",
        payload,
      );

      const res = await ctx.get(`/api/${orgSlug}/files/${key}`, {
        headers: { Range: "bytes=0-3" },
        maxRedirects: 0,
      });
      expect(res.status()).toBe(206);
      expect(res.headers()["content-range"]).toContain("bytes 0-3/");
      expect((await res.body()).equals(payload.subarray(0, 4))).toBe(true);

      await ctx.dispose();
    });

    test("maps an upstream miss to 404", async ({ playwright }) => {
      const ctx = await newApiContext(playwright);
      const { orgSlug } = await signUpViaApi(ctx);

      const res = await ctx.get(`/api/${orgSlug}/files/${uniqueKey("txt")}`, {
        maxRedirects: 0,
      });
      expect(res.status()).toBe(404);

      await ctx.dispose();
    });
  });
});
