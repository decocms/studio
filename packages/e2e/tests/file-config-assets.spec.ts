import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

const s3Configured = !!(
  process.env.S3_ENDPOINT &&
  process.env.S3_BUCKET &&
  process.env.S3_ACCESS_KEY_ID &&
  process.env.S3_SECRET_ACCESS_KEY
);

interface Asset {
  key: string;
  publicUrl: string;
  size: number;
}
interface AssetPage {
  items: Asset[];
  nextCursor: string | null;
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
  "base64",
);

test("custom bucket lists legacy and new assets without an index and filters images before pagination", async ({
  playwright,
}) => {
  test.skip(!s3Configured, "requires the E2E S3 service");
  const request = await newApiContext(playwright);
  const { orgSlug } = await signUpViaApi(request);
  const orgs = (await (
    await request.get("/api/auth/organization/list")
  ).json()) as Array<{ id: string; slug: string }>;
  const orgId = orgs.find((org) => org.slug === orgSlug)!.id;
  const relativePrefix = `incoming/example-${crypto.randomUUID()}/`;
  const prefix = `${orgId}/${relativePrefix}`;
  const config = await callSelfMcpTool<{ id: string }>(
    request,
    orgSlug,
    "FILE_CONFIG_CREATE",
    {
      name: "editorial-assets",
      bucket: process.env.S3_BUCKET,
      region: "us-east-1",
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: true,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      prefix,
      publicUrlBase: "https://cdn.example.com/image-service/",
    },
  );
  const storedKeys: string[] = [];
  try {
    // Seed a pre-existing layout through S3, without any file-config upload or index write.
    const legacyKey = `${relativePrefix}legacy-id/Old cover.PNG`;
    const { url } = await callSelfMcpTool<{ url: string }>(
      request,
      orgSlug,
      "PUT_PRESIGNED_URL",
      { key: legacyKey, contentType: "image/png" },
    );
    expect(
      (
        await request.put(url, {
          data: png,
          headers: { "Content-Type": "image/png" },
        })
      ).ok(),
    ).toBe(true);
    storedKeys.push(`${orgId}/${legacyKey}`);

    for (const [filename, contentType, data] of [
      ["New cover.png", "image/png", png],
      ["Guide.pdf", "application/pdf", Buffer.from("%PDF-1.4\n%%EOF")],
    ] as const) {
      const response = await request.post(
        `/api/${orgSlug}/file-configs/${config.id}/upload?filename=${encodeURIComponent(filename)}`,
        { data, headers: { "Content-Type": contentType } },
      );
      expect(response.ok(), await response.text()).toBe(true);
      const uploaded = (await response.json()) as Asset;
      storedKeys.push(uploaded.key);
      expect(uploaded.key.startsWith(prefix)).toBe(true);
      expect(uploaded.size).toBe(data.byteLength);
      expect(uploaded.publicUrl).toBe(
        `https://cdn.example.com/image-service/${uploaded.key.split("/").map(encodeURIComponent).join("/")}`,
      );
      const download = await callSelfMcpTool<{ url: string }>(
        request,
        orgSlug,
        "GET_PRESIGNED_URL",
        { key: uploaded.key.slice(orgId.length + 1) },
      );
      expect(await (await request.get(download.url)).body()).toEqual(data);
    }

    const list = (args: Record<string, unknown> = {}) =>
      callSelfMcpTool<AssetPage>(request, orgSlug, "FILE_OBJECTS_LIST", {
        configId: config.id,
        ...args,
      });
    const all = await list();
    expect(
      all.items.find((item) => item.key === storedKeys[0])?.publicUrl,
    ).toBe(
      `https://cdn.example.com/image-service/${prefix}legacy-id/Old%20cover.PNG`,
    );
    expect(all.items.map((item) => item.key).sort()).toEqual(
      [...storedKeys].sort(),
    );
    const imageKeys: string[] = [];
    let cursor: string | null = null;
    do {
      const page: AssetPage = await list({
        imageOnly: true,
        maxKeys: 1,
        cursor,
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.key).toMatch(/\.png$/i);
      imageKeys.push(page.items[0]!.key);
      cursor = page.nextCursor;
      expect(imageKeys.length).toBeLessThanOrEqual(2);
    } while (cursor);
    expect(imageKeys.sort()).toEqual(storedKeys.slice(0, 2).sort());
    expect(
      (await list({ imageOnly: true, search: "cover" })).items,
    ).toHaveLength(2);
    expect((await list({ imageOnly: true, search: "guide" })).items).toEqual(
      [],
    );
    expect((await list({ search: "guide" })).items).toHaveLength(1);
    for (const key of storedKeys.slice(0, 2)) {
      await callSelfMcpTool(request, orgSlug, "FILE_OBJECT_DELETE", {
        configId: config.id,
        key,
      });
    }
    expect(await list({ imageOnly: true, maxKeys: 1 })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await list()).items).toHaveLength(1);
  } finally {
    for (const key of storedKeys) {
      await callSelfMcpTool(request, orgSlug, "FILE_OBJECT_DELETE", {
        configId: config.id,
        key,
      });
    }
    await callSelfMcpTool(request, orgSlug, "FILE_CONFIG_DELETE", {
      id: config.id,
    });
    await request.dispose();
  }
});
