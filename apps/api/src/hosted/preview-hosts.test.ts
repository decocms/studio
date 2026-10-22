import { describe, expect, it } from "bun:test";
import { previewHostsOf, sitePreviewHosts } from "./preview-hosts";

describe("previewHostsOf", () => {
  it("is each address's host, lowercase, sorted, without duplicates", () => {
    expect(
      previewHostsOf([
        "https://www.Acme.com/some/page?x=1",
        "acme.deco.site",
        "www.acme.com",
        "ACME.DECO.SITE.",
      ]),
    ).toEqual(["acme.deco.site", "www.acme.com"]);
  });

  it("keeps a port only when the address names one", () => {
    expect(
      previewHostsOf([
        "https://localhost:3100/",
        "https://acme.com:443/",
        "http://[::1]:8000",
      ]),
    ).toEqual(["[::1]:8000", "acme.com", "localhost:3100"]);
  });

  it("writes a name outside ASCII in its punycode form", () => {
    expect(previewHostsOf(["loja-ação.com.br"])).toEqual([
      "xn--loja-ao-2wa9a.com.br",
    ]);
  });

  it("leaves out what isn't an address", () => {
    expect(
      previewHostsOf([
        null,
        undefined,
        "",
        "   ",
        "ftp://acme.com",
        "a b",
        "https://a..b/",
      ]),
    ).toEqual([]);
  });
});

describe("sitePreviewHosts", () => {
  it("is the preview server's host and the site's domains", async () => {
    const hosts = await sitePreviewHosts({
      site: "acme",
      metadata: { previewServerUrl: "https://staging.acme.com" },
      domains: async (site) =>
        site === "acme" ? ["acme.deco.site", "www.acme.com"] : [],
    });
    expect(hosts).toEqual([
      "acme.deco.site",
      "staging.acme.com",
      "www.acme.com",
    ]);
  });

  it("reads the legacy productionUrl when there is no previewServerUrl", async () => {
    const hosts = await sitePreviewHosts({
      site: "acme",
      metadata: { productionUrl: "https://acme.deco.site" },
      domains: async () => [],
    });
    expect(hosts).toEqual(["acme.deco.site"]);
  });

  it("is the domains alone without a preview server, and empty with neither", async () => {
    expect(
      await sitePreviewHosts({
        site: "acme",
        metadata: null,
        domains: async () => ["www.acme.com"],
      }),
    ).toEqual(["www.acme.com"]);
    expect(
      await sitePreviewHosts({
        site: "acme",
        metadata: {},
        domains: async () => [],
      }),
    ).toEqual([]);
  });

  it("never fails when the domains can't be read", async () => {
    const hosts = await sitePreviewHosts({
      site: "acme",
      metadata: { previewServerUrl: "https://www.acme.com" },
      domains: async () => {
        throw new Error("supabase down");
      },
    });
    expect(hosts).toEqual(["www.acme.com"]);
  });
});
