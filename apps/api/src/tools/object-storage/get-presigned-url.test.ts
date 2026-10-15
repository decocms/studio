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

  describe("Library files (`_fs/` keys)", () => {
    function libraryCtx() {
      const presignedGetUrl = mock(async () => "https://s3/x");
      const ctx = {
        auth: { user: { id: "user-1" } },
        organization: { id: "org-a" },
        access: { check: mock(async () => {}) },
        objectStorage: { presignedGetUrl },
      } as unknown as Parameters<typeof GET_PRESIGNED_URL.handler>[1];
      return { ctx, presignedGetUrl };
    }

    it("refuses to read another member's home folder", async () => {
      const { ctx } = libraryCtx();
      await expect(
        GET_PRESIGNED_URL.handler(
          { key: "_fs/home/users/user-2/notes.md" },
          ctx,
        ),
      ).rejects.toThrow();
    });

    it("still presigns the caller's own home files and shared volumes", async () => {
      const { ctx, presignedGetUrl } = libraryCtx();
      await expect(
        GET_PRESIGNED_URL.handler(
          { key: "_fs/home/users/user-1/notes.md" },
          ctx,
        ),
      ).resolves.toHaveProperty("url");
      await expect(
        GET_PRESIGNED_URL.handler({ key: "_fs/shared/README.md" }, ctx),
      ).resolves.toHaveProperty("url");
      expect(presignedGetUrl).toHaveBeenCalledTimes(2);
    });
  });
});
