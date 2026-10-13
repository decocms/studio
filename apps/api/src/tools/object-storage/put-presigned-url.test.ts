import { describe, expect, it, mock } from "bun:test";
import { PUT_PRESIGNED_URL } from "./put-presigned-url";

describe("PUT_PRESIGNED_URL", () => {
  it("clamps an out-of-range expiresIn instead of passing it straight to S3", async () => {
    const presignedPutUrl = mock(
      async (key: string, expiresIn?: number, contentType?: string) =>
        `https://s3/${key}?ttl=${expiresIn}&type=${contentType}`,
    );
    const ctx = {
      auth: { user: { id: "user-1" } },
      organization: { id: "org-a" },
      access: { check: mock(async () => {}) },
      objectStorage: { presignedPutUrl },
    } as unknown as Parameters<typeof PUT_PRESIGNED_URL.handler>[1];

    const tooLong = await PUT_PRESIGNED_URL.handler(
      { key: "uploads/report.pdf", expiresIn: 999_999_999 },
      ctx,
    );
    expect(tooLong.expiresIn).toBe(604800);
    expect(presignedPutUrl).toHaveBeenLastCalledWith(
      "uploads/report.pdf",
      604800,
      undefined,
    );

    const tooShort = await PUT_PRESIGNED_URL.handler(
      { key: "uploads/report.pdf", expiresIn: -5 },
      ctx,
    );
    expect(tooShort.expiresIn).toBe(60);
  });

  it("refuses keys in the org filesystem, which would skip the file index", async () => {
    const presignedPutUrl = mock(async () => "https://s3/x");
    const ctx = {
      auth: { user: { id: "user-1" } },
      organization: { id: "org-a" },
      access: { check: mock(async () => {}) },
      objectStorage: { presignedPutUrl },
    } as unknown as Parameters<typeof PUT_PRESIGNED_URL.handler>[1];

    await expect(
      PUT_PRESIGNED_URL.handler({ key: "_fs/home/pages/a.html" }, ctx),
    ).rejects.toThrow("org filesystem");
    await expect(
      PUT_PRESIGNED_URL.handler({ key: "pages/../_fs/home/a.html" }, ctx),
    ).rejects.toThrow("org filesystem");
    expect(presignedPutUrl).not.toHaveBeenCalled();
  });
});
