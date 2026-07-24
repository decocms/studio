import { describe, expect, it } from "bun:test";
import { checkDomainTxt, verificationRecordName } from "./domain-verification";

describe("verificationRecordName", () => {
  it("prefixes the domain and lowercases it", () => {
    expect(verificationRecordName("Acme.COM")).toBe("_deco-verify.acme.com");
  });
});

describe("checkDomainTxt", () => {
  it("matches when a TXT record equals the token", async () => {
    const resolver = async () => [["other-record"], ["my-token"]];
    expect(await checkDomainTxt("acme.com", "my-token", resolver)).toBe(true);
  });

  it("joins chunked TXT records before comparing", async () => {
    const resolver = async () => [["my-", "token"]];
    expect(await checkDomainTxt("acme.com", "my-token", resolver)).toBe(true);
  });

  it("returns false when no record matches", async () => {
    const resolver = async () => [["nope"]];
    expect(await checkDomainTxt("acme.com", "my-token", resolver)).toBe(false);
  });

  it("returns false on resolver error (NXDOMAIN)", async () => {
    const resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await checkDomainTxt("acme.com", "my-token", resolver)).toBe(false);
  });

  it("returns false for an empty token", async () => {
    const resolver = async () => [[""]];
    expect(await checkDomainTxt("acme.com", "", resolver)).toBe(false);
  });
});
