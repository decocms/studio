import { describe, expect, it } from "bun:test";
import {
  flattenGaOptions,
  isConfigured,
  matchVerifiedSite,
  mergeConfigState,
  parseAccountSummaries,
  parseListSites,
} from "./companion-config-core.ts";

const GA_RAW = {
  response: {
    accountSummaries: [
      {
        account: "accounts/1",
        displayName: "Acct One",
        propertySummaries: [
          { property: "properties/100", displayName: "Site A" },
        ],
      },
      {
        account: "accounts/2",
        displayName: "Acct Two",
        propertySummaries: [
          { property: "properties/200", displayName: "Site B" },
          { property: "properties/201", displayName: "Site C" },
        ],
      },
    ],
  },
};

describe("parseAccountSummaries", () => {
  it("groups properties under account displayName, preserving order", () => {
    expect(parseAccountSummaries(GA_RAW)).toEqual([
      {
        account: "Acct One",
        options: [{ value: "properties/100", label: "Site A" }],
      },
      {
        account: "Acct Two",
        options: [
          { value: "properties/200", label: "Site B" },
          { value: "properties/201", label: "Site C" },
        ],
      },
    ]);
  });

  it("returns [] for malformed/empty input", () => {
    expect(parseAccountSummaries(null)).toEqual([]);
    expect(parseAccountSummaries({})).toEqual([]);
    expect(
      parseAccountSummaries({ response: { accountSummaries: [] } }),
    ).toEqual([]);
  });
});

describe("flattenGaOptions", () => {
  it("flattens all options across groups", () => {
    const groups = parseAccountSummaries(GA_RAW);
    expect(flattenGaOptions(groups).map((o) => o.value)).toEqual([
      "properties/100",
      "properties/200",
      "properties/201",
    ]);
  });
});

describe("parseListSites", () => {
  it("extracts siteUrl entries", () => {
    const raw = {
      sites: [
        {
          siteUrl: "https://www.bite.com.br/",
          permissionLevel: "siteFullUser",
        },
        { siteUrl: "sc-domain:deco.site", permissionLevel: "siteOwner" },
      ],
    };
    expect(parseListSites(raw)).toEqual([
      { siteUrl: "https://www.bite.com.br/" },
      { siteUrl: "sc-domain:deco.site" },
    ]);
  });

  it("returns [] for malformed input", () => {
    expect(parseListSites(null)).toEqual([]);
    expect(parseListSites({})).toEqual([]);
  });
});

describe("matchVerifiedSite", () => {
  const sites = [
    { siteUrl: "https://www.bite.com.br/" },
    { siteUrl: "sc-domain:deco.site" },
    { siteUrl: "https://shop.example.com/" },
  ];

  it("matches an sc-domain property by host", () => {
    expect(matchVerifiedSite("deco.site", sites)).toBe("sc-domain:deco.site");
  });

  it("matches a URL-prefix property ignoring www", () => {
    expect(matchVerifiedSite("bite.com.br", sites)).toBe(
      "https://www.bite.com.br/",
    );
  });

  it("returns null when nothing matches", () => {
    expect(matchVerifiedSite("nope.com", sites)).toBeNull();
  });

  it("returns null for a null host", () => {
    expect(matchVerifiedSite(null, sites)).toBeNull();
  });

  it("returns null when the host is ambiguous (multiple matches)", () => {
    const ambiguous = [
      { siteUrl: "sc-domain:dup.com" },
      { siteUrl: "https://dup.com/" },
    ];
    expect(matchVerifiedSite("dup.com", ambiguous)).toBeNull();
  });
});

describe("isConfigured", () => {
  it("true when anchor field is a non-empty value", () => {
    expect(isConfigured({ propertyId: "properties/1" }, "propertyId")).toBe(
      true,
    );
    expect(isConfigured({ accountName: "mystore" }, "accountName")).toBe(true);
  });

  it("false when missing, empty, or null", () => {
    expect(isConfigured({}, "propertyId")).toBe(false);
    expect(isConfigured({ propertyId: "" }, "propertyId")).toBe(false);
    expect(isConfigured({ propertyId: null }, "propertyId")).toBe(false);
    expect(isConfigured(null, "propertyId")).toBe(false);
  });
});

describe("mergeConfigState", () => {
  it("shallow-merges patch over existing state", () => {
    expect(
      mergeConfigState({ a: 1, propertyId: "old" }, { propertyId: "new" }),
    ).toEqual({ a: 1, propertyId: "new" });
  });

  it("treats null/undefined state as empty", () => {
    expect(mergeConfigState(null, { siteUrl: "x" })).toEqual({ siteUrl: "x" });
  });
});
