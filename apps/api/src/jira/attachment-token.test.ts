import { describe, expect, it } from "bun:test";
import { mintAttachmentToken, verifyAttachmentToken } from "./attachment-token";

describe("attachment token", () => {
  const grant = {
    organizationId: "org_1",
    attachmentId: "10042",
    expiresAt: 2_000_000,
  };

  it("round-trips a grant while it is live", () => {
    const token = mintAttachmentToken(grant);
    expect(verifyAttachmentToken(token, 1_000_000)).toEqual(grant);
  });

  it("refuses an expired grant", () => {
    const token = mintAttachmentToken(grant);
    expect(verifyAttachmentToken(token, 2_000_000)).toBeNull();
  });

  /** The token is the only authentication on the download route, so a payload
   *  edit — another attachment, another org, a later expiry — must fail. */
  it("refuses a token whose payload was edited", () => {
    const token = mintAttachmentToken(grant);
    const [, mac] = token.split(".");
    const edited = Buffer.from(
      JSON.stringify({ ...grant, attachmentId: "10043" }),
    ).toString("base64url");
    expect(verifyAttachmentToken(`${edited}.${mac}`, 1_000_000)).toBeNull();
  });

  it("refuses garbage", () => {
    for (const bad of ["", "abc", "abc.def", "not-base64.zz"]) {
      expect(verifyAttachmentToken(bad, 1_000_000)).toBeNull();
    }
  });
});
