import { describe, expect, test } from "bun:test";
import {
  defaultOrgNameForUser,
  domainDisplayName,
  domainToOrgSlug,
  emailDomainOf,
  isCorporateEmailDomain,
  isDiscoverableDomainRecord,
  isVerifiedCorporateUser,
} from "./org-assurance-policy";

describe("org assurance policy", () => {
  test("extracts and normalizes email domains", () => {
    expect(emailDomainOf("Ada@Deco.CX")).toBe("deco.cx");
    expect(emailDomainOf("ada")).toBeNull();
    expect(emailDomainOf("ada@")).toBeNull();
    expect(emailDomainOf("@deco.cx")).toBeNull();
  });

  test("classifies corporate domains by excluding generic providers", () => {
    expect(isCorporateEmailDomain("deco.cx")).toBe(true);
    expect(isCorporateEmailDomain("gmail.com")).toBe(false);
    expect(isCorporateEmailDomain("GOOGLEMAIL.COM")).toBe(false);
    expect(isCorporateEmailDomain("")).toBe(false);
  });

  test("builds unique full-domain organization slugs", () => {
    expect(domainToOrgSlug("deco.cx")).toBe("deco-cx");
    expect(domainToOrgSlug("shop.example.com")).toBe("shop-example-com");
    expect(domainToOrgSlug(" ACME--Store.io ")).toBe("acme-store-io");
  });

  test("builds readable organization names from domains", () => {
    expect(domainDisplayName("deco.cx")).toBe("Deco");
    expect(domainDisplayName("shop.example.com")).toBe("Shop");
  });

  test("detects verified corporate users", () => {
    expect(
      isVerifiedCorporateUser({
        email: "admin@deco.cx",
        emailVerified: true,
      }),
    ).toBe(true);
    expect(
      isVerifiedCorporateUser({
        email: "admin@gmail.com",
        emailVerified: true,
      }),
    ).toBe(false);
    expect(
      isVerifiedCorporateUser({
        email: "admin@deco.cx",
        emailVerified: false,
      }),
    ).toBe(false);
  });

  test("uses name first for generic default org names", () => {
    expect(
      defaultOrgNameForUser({
        email: "ada@example.com",
        name: "Ada Lovelace",
      }),
    ).toBe("Ada");
    expect(
      defaultOrgNameForUser({
        email: "no-name@example.com",
        name: null,
      }),
    ).toBe("no-name");
  });

  test("only treats verified auto and request domain records as discoverable", () => {
    expect(
      isDiscoverableDomainRecord({
        verificationStatus: "verified",
        joinMode: "auto",
      }),
    ).toBe(true);
    expect(
      isDiscoverableDomainRecord({
        verificationStatus: "verified",
        joinMode: "request",
      }),
    ).toBe(true);
    expect(
      isDiscoverableDomainRecord({
        verificationStatus: "verified",
        joinMode: "off",
      }),
    ).toBe(false);
    expect(
      isDiscoverableDomainRecord({
        verificationStatus: "pending",
        joinMode: "auto",
      }),
    ).toBe(false);
  });
});
