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

  it("refuses to read another member's home folder", async () => {
    const head = mock(async () => ({
      contentType: "text/markdown",
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

    await expect(
      GET_OBJECT_METADATA.handler(
        { key: "_fs/home/users/user-2/notes.md" },
        ctx,
      ),
    ).rejects.toThrow();
    expect(head).not.toHaveBeenCalled();
  });

  it("still reads the caller's own home files and shared volumes", async () => {
    const head = mock(async () => ({
      contentType: "text/markdown",
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

    await expect(
      GET_OBJECT_METADATA.handler(
        { key: "_fs/home/users/user-1/notes.md" },
        ctx,
      ),
    ).resolves.toHaveProperty("contentType");
    await expect(
      GET_OBJECT_METADATA.handler({ key: "_fs/shared/README.md" }, ctx),
    ).resolves.toHaveProperty("contentType");
    expect(head).toHaveBeenCalledTimes(2);
  });
});
