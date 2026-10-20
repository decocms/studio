import { describe, expect, it, mock } from "bun:test";
import { verifyOrgFsUploadToken } from "../../file-storage/upload-grant";
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

  describe("Library files (`_fs/` keys)", () => {
    function libraryCtx(syncVolumes: string[] = []) {
      const presignedPutUrl = mock(async () => "https://s3/x");
      const ctx = {
        auth: { user: { id: "user-1" } },
        organization: { id: "org-a", slug: "acme" },
        access: { check: mock(async () => {}) },
        objectStorage: { presignedPutUrl },
        orgFs: {},
        storage: {
          orgRepoSyncs: {
            isSyncVolume: mock(async (_org: string, volume: string) =>
              syncVolumes.includes(volume),
            ),
          },
        },
      } as unknown as Parameters<typeof PUT_PRESIGNED_URL.handler>[1];
      return { ctx, presignedPutUrl };
    }

    it("returns a Studio upload URL bound to the file and the caller", async () => {
      const { ctx, presignedPutUrl } = libraryCtx();
      const { url, expiresIn } = await PUT_PRESIGNED_URL.handler(
        { key: "uploads/../_fs/home/pages/a.html", expiresIn: 999_999 },
        ctx,
      );

      expect(expiresIn).toBe(3600);
      const token = url.match(/\/api\/acme\/fs\/home\/upload\/([^/]+)$/)?.[1];
      expect(verifyOrgFsUploadToken(token ?? "")).toMatchObject({
        organizationId: "org-a",
        volume: "home",
        path: "pages/a.html",
        userId: "user-1",
      });
      expect(presignedPutUrl).not.toHaveBeenCalled();
    });

    it("refuses what the fs routes refuse", async () => {
      const { ctx } = libraryCtx(["mirror"]);
      const refused = [
        "_fs/home/users/user-2/notes.md",
        "_fs/mirror/README.md",
        "_fs/public-core/skill.md",
        "_fs/home",
      ];
      for (const key of refused) {
        await expect(PUT_PRESIGNED_URL.handler({ key }, ctx)).rejects.toThrow();
      }
      await expect(
        PUT_PRESIGNED_URL.handler(
          { key: "_fs/home/users/user-1/notes.md" },
          ctx,
        ),
      ).resolves.toHaveProperty("url");
    });
  });
});
