import { createServer } from "node:http";
import { once } from "node:events";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// The infrastructure edge speaks S3 XML; the API uses its real AWS client.
test("listing denial leaves uploads available and other S3 failures remain errors", async ({
  authedPage: { page, orgSlug },
}, testInfo) => {
  test.setTimeout(120_000);
  let listError: string | null = "AccessDenied";
  let denyUpload = false;
  const uploaded: Buffer[] = [];
  const s3 = createServer(async (request, response) => {
    const error =
      request.method === "PUT"
        ? denyUpload
          ? "AccessDenied"
          : null
        : listError;
    if (error) {
      response.writeHead(403, { "Content-Type": "application/xml" });
      response.end(
        `<Error><Code>${error}</Code><Message>Storage request failed</Message></Error>`,
      );
      return;
    }
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      uploaded.push(Buffer.concat(chunks));
      response.writeHead(200, { ETag: '"example-etag"' });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/xml" });
    response.end(
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListBucketResult>',
    );
  });
  s3.listen(0, "127.0.0.1");
  await once(s3, "listening");
  const address = s3.address();
  if (!address || typeof address === "string")
    throw new Error("Missing S3 address");
  try {
    const request = page.context().request;
    const config = await callSelfMcpTool<{ id: string }>(
      request,
      orgSlug,
      "FILE_CONFIG_CREATE",
      {
        name: "editorial-uploads",
        bucket: "example-media",
        region: "us-east-1",
        endpoint: `http://127.0.0.1:${address.port}`,
        forcePathStyle: true,
        prefix: "incoming/example/",
        publicUrlBase: "https://cdn.example.com",
        accessKeyId: "example-key",
        secretAccessKey: "example-secret",
      },
    );
    const list = () =>
      callSelfMcpTool(request, orgSlug, "FILE_OBJECTS_LIST", {
        configId: config.id,
      });
    await expect(list()).resolves.toEqual({
      items: [],
      nextCursor: null,
      listingError: "access_denied",
    });
    const payload = Buffer.from("example file contents");
    const upload = () =>
      request.post(
        `/api/${orgSlug}/file-configs/${config.id}/upload?filename=notes.txt`,
        {
          data: payload,
          headers: { "Content-Type": "text/plain" },
        },
      );
    const result = await upload();
    expect(result.ok(), await result.text()).toBe(true);
    const uploadedUrl = new URL((await result.json()).publicUrl);
    expect(uploadedUrl.origin).toBe("https://cdn.example.com");
    expect(uploadedUrl.pathname).toMatch(/^\/incoming\/example\/.+notes\.txt$/);
    expect(uploaded).toEqual([payload]);

    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "Editorial project",
          status: "active",
          connections: [],
          metadata: { assetStorageConfigId: config.id },
        },
      },
    );
    await page.goto(`/${orgSlug}/projects/${item.id}/assets`);
    await expect(
      page.getByText(
        "Your bucket permissions do not allow listing existing files. You can still try uploading a new file.",
      ),
    ).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: testInfo.outputPath("listing-denied.png") });
    await expect(
      page.getByText("No files in this bucket yet", { exact: true }),
    ).toHaveCount(0);
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/tools/FILE_OBJECTS_LIST"),
      ),
      page.locator('input[type="file"]').setInputFiles({
        name: "browser-upload.txt",
        mimeType: "text/plain",
        buffer: payload,
      }),
    ]);
    await expect.poll(() => uploaded.length).toBe(2);
    await expect(
      page.getByRole("button", { name: "Retry listing" }),
    ).toBeEnabled();
    listError = null;
    await page.getByRole("button", { name: "Retry listing" }).click();
    await expect(
      page.getByText("No files in this bucket yet", { exact: true }),
    ).toBeVisible();
    await expect(list()).resolves.toEqual({ items: [], nextCursor: null });
    for (const code of [
      "InvalidAccessKeyId",
      "SignatureDoesNotMatch",
      "NoSuchBucket",
    ]) {
      listError = code;
      await expect(list()).rejects.toThrow();
    }
    await page.reload();
    await expect(
      page.getByText(
        "Could not load files from this bucket. Try again. You can still try uploading a new file.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Your bucket permissions do not allow listing existing files. You can still try uploading a new file.",
      ),
    ).toHaveCount(0);
    denyUpload = true;
    expect((await upload()).ok()).toBe(false);
    expect(uploaded).toEqual([payload, payload]);
  } finally {
    s3.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      s3.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
