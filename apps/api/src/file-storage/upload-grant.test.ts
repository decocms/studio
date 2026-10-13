import { describe, expect, it } from "bun:test";
import { mintAttachmentToken } from "@/jira/attachment-token";
import { mintOrgFsUploadToken, verifyOrgFsUploadToken } from "./upload-grant";

describe("org-fs upload grant", () => {
  const grant = {
    organizationId: "org_1",
    volume: "home",
    path: "pages/a.html",
    userId: "user_1",
    expiresAt: 2_000_000,
  };

  it("round-trips a grant while it is live", () => {
    expect(
      verifyOrgFsUploadToken(mintOrgFsUploadToken(grant), 1_000_000),
    ).toEqual(grant);
  });

  it("refuses an expired grant", () => {
    expect(
      verifyOrgFsUploadToken(mintOrgFsUploadToken(grant), 2_000_000),
    ).toBeNull();
  });

  /** The token is the upload route's only authentication. */
  it("refuses a token whose payload was edited", () => {
    const [, mac] = mintOrgFsUploadToken(grant).split(".");
    const edited = Buffer.from(
      JSON.stringify({
        ...grant,
        purpose: "org-fs-upload",
        path: "pages/b.html",
      }),
    ).toString("base64url");
    expect(verifyOrgFsUploadToken(`${edited}.${mac}`, 1_000_000)).toBeNull();
  });

  it("refuses another grant type signed with the same key", () => {
    const attachment = mintAttachmentToken({
      organizationId: "org_1",
      attachmentId: "10042",
      expiresAt: 2_000_000,
    });
    expect(verifyOrgFsUploadToken(attachment, 1_000_000)).toBeNull();
  });

  it("refuses garbage", () => {
    expect(verifyOrgFsUploadToken("", 0)).toBeNull();
    expect(verifyOrgFsUploadToken("not-a-token", 0)).toBeNull();
  });
});
