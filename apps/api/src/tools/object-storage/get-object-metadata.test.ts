import { describe, expect, it, mock } from "bun:test";
import { GET_OBJECT_METADATA } from "./get-object-metadata";

describe("GET_OBJECT_METADATA", () => {
  it("surfaces the object's custom S3 metadata", async () => {
    const head = mock(async () => ({
      contentType: "image/png",
      size: 42,
      lastModified: new Date("2026-01-01T00:00:00.000Z"),
      etag: '"abc"',
      metadata: { uploadedBy: "user-1" },
    }));
    const ctx = {
      auth: { user: { id: "user-1" } },
      organization: { id: "org-a" },
      access: { check: mock(async () => {}) },
      objectStorage: { head },
    } as unknown as Parameters<typeof GET_OBJECT_METADATA.handler>[1];

    const result = await GET_OBJECT_METADATA.handler(
      { key: "images/logo.png" },
      ctx,
    );

    expect(result.metadata).toEqual({ uploadedBy: "user-1" });
  });

  it("omits metadata when the object has none", async () => {
    const head = mock(async () => ({
      contentType: "image/png",
      size: 42,
      lastModified: new Date("2026-01-01T00:00:00.000Z"),
      etag: '"abc"',
    }));
    const ctx = {
      auth: { user: { id: "user-1" } },
      organization: { id: "org-a" },
      access: { check: mock(async () => {}) },
      objectStorage: { head },
    } as unknown as Parameters<typeof GET_OBJECT_METADATA.handler>[1];

    const result = await GET_OBJECT_METADATA.handler(
      { key: "images/logo.png" },
      ctx,
    );

    expect(result.metadata).toBeUndefined();
  });
});
