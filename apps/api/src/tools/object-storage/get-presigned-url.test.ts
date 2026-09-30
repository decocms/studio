import { describe, expect, it, mock } from "bun:test";
import { GET_PRESIGNED_URL } from "./get-presigned-url";

describe("GET_PRESIGNED_URL", () => {
  it("clamps an out-of-range expiresIn instead of passing it straight to S3", async () => {
    const presignedGetUrl = mock(
      async (key: string, expiresIn?: number) =>
        `https://s3/${key}?ttl=${expiresIn}`,
    );
    const ctx = {
      auth: { user: { id: "user-1" } },
      organization: { id: "org-a" },
      access: { check: mock(async () => {}) },
      objectStorage: { presignedGetUrl },
    } as unknown as Parameters<typeof GET_PRESIGNED_URL.handler>[1];

    const tooLong = await GET_PRESIGNED_URL.handler(
      { key: "pages/home.html", expiresIn: 999_999_999 },
      ctx,
    );
    expect(tooLong.expiresIn).toBe(604800);
    expect(presignedGetUrl).toHaveBeenLastCalledWith("pages/home.html", 604800);

    const tooShort = await GET_PRESIGNED_URL.handler(
      { key: "pages/home.html", expiresIn: -5 },
      ctx,
    );
    expect(tooShort.expiresIn).toBe(60);
  });
});
