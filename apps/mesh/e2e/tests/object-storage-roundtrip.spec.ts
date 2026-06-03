/**
 * End-to-end roundtrip for mesh's object storage tools against real S3.
 *
 * In CI (e2e.yml) the running app is configured with S3_* env vars pointing at
 * a MinIO container, so the OBJECT_STORAGE binding resolves to the production
 * S3Service path (not the DevObjectStorage filesystem fallback). This exercises
 * the whole chain through the app:
 *
 *   PUT_PRESIGNED_URL (mcp/self)  → presigned PUT URL at MinIO
 *     → client uploads bytes straight to MinIO
 *   LIST_OBJECTS / GET_OBJECT_METADATA → object is visible + sized correctly
 *   GET_PRESIGNED_URL → presigned GET URL → client downloads the same bytes
 *   DELETE_OBJECT → object is gone
 *
 * Skips when S3 isn't configured (e.g. a plain local `bun run test:e2e` with no
 * MinIO) so it stays green on the filesystem-backed dev path, where presigned
 * GET returns a data: URL rather than a fetchable MinIO URL.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

const s3Configured = !!(
  process.env.S3_ENDPOINT &&
  process.env.S3_BUCKET &&
  process.env.S3_ACCESS_KEY_ID &&
  process.env.S3_SECRET_ACCESS_KEY
);

test.describe("Object storage roundtrip (S3)", () => {
  test.skip(
    !s3Configured,
    "requires S3 env (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY); see e2e.yml MinIO setup",
  );

  test("uploads, lists, downloads and deletes an object through MCP tools", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);
    const { orgSlug } = user;

    const key = `e2e/${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
    const contentType = "application/octet-stream";
    const payload = Buffer.from(`object-storage roundtrip ${key}\n`.repeat(8));

    // 1. Mint a presigned PUT URL and upload bytes straight to MinIO.
    const put = await callSelfMcpTool<{ url: string; expiresIn: number }>(
      ctx,
      orgSlug,
      "PUT_PRESIGNED_URL",
      { key, contentType },
    );
    expect(put.url).toMatch(/^https?:\/\//);

    // contentType is part of the signed headers, so the upload must replay it
    // verbatim or MinIO rejects the signature.
    const uploadRes = await ctx.fetch(put.url, {
      method: "PUT",
      data: payload,
      headers: { "content-type": contentType },
    });
    expect(
      uploadRes.ok(),
      `upload failed: HTTP ${uploadRes.status()} — ${await uploadRes
        .text()
        .catch(() => "<unreadable>")}`,
    ).toBe(true);

    // 2. The object shows up in a prefix listing, scoped to this org.
    const listed = await callSelfMcpTool<{
      objects: Array<{ key: string; size: number }>;
    }>(ctx, orgSlug, "LIST_OBJECTS", { prefix: "e2e/" });
    const entry = listed.objects.find((o) => o.key === key);
    expect(entry, `object ${key} not found in listing`).toBeDefined();
    expect(entry!.size).toBe(payload.length);

    // 3. HEAD metadata matches what we uploaded.
    const meta = await callSelfMcpTool<{
      contentType?: string;
      contentLength: number;
    }>(ctx, orgSlug, "GET_OBJECT_METADATA", { key });
    expect(meta.contentLength).toBe(payload.length);
    expect(meta.contentType).toBe(contentType);

    // 4. Presigned GET returns the exact bytes back.
    const get = await callSelfMcpTool<{ url: string }>(
      ctx,
      orgSlug,
      "GET_PRESIGNED_URL",
      { key },
    );
    const downloadRes = await ctx.get(get.url);
    expect(downloadRes.ok()).toBe(true);
    const downloaded = await downloadRes.body();
    expect(downloaded.equals(payload)).toBe(true);

    // 5. Delete removes it — a follow-up metadata read fails closed.
    const del = await callSelfMcpTool<{ success: boolean; key: string }>(
      ctx,
      orgSlug,
      "DELETE_OBJECT",
      { key },
    );
    expect(del.success).toBe(true);
    await expect(
      callSelfMcpTool(ctx, orgSlug, "GET_OBJECT_METADATA", { key }),
    ).rejects.toThrow();

    await ctx.dispose();
  });
});
