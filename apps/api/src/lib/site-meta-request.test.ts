import { describe, expect, it } from "bun:test";
import {
  buildSiteMetaRequest,
  isJsonContentType,
  isTrustedSiteOrigin,
  resolveSiteMetaTarget,
  SITE_ADMIN_TOKEN_HEADER,
  siteMetaResponseHeaders,
} from "./site-meta-request";

describe("resolveSiteMetaTarget", () => {
  it("reads the site's platform host when the project has a site slug", () => {
    expect(
      resolveSiteMetaTarget({
        siteSlug: "acme",
        previewServerUrl: "https://attacker.example",
      }),
    ).toEqual({ siteUrl: "https://acme.deco.site/", trusted: true });
  });

  it("cannot be steered off the platform domain through the slug", () => {
    const target = resolveSiteMetaTarget({ siteSlug: "evil.example/#" });
    expect(target?.trusted).toBe(true);
    expect(new URL(target!.siteUrl).hostname.endsWith(".deco.site")).toBe(true);
  });

  it("falls back to the editor's preview URL without trust", () => {
    expect(
      resolveSiteMetaTarget({ previewServerUrl: "https://store.example.com" }),
    ).toEqual({ siteUrl: "https://store.example.com/", trusted: false });
    expect(
      resolveSiteMetaTarget({
        siteSlug: "",
        productionUrl: "https://store.example.com",
      }),
    ).toEqual({ siteUrl: "https://store.example.com/", trusted: false });
  });

  it("is null without a slug or a preview URL", () => {
    expect(resolveSiteMetaTarget(null)).toBeNull();
    expect(resolveSiteMetaTarget({ siteSlug: 42 })).toBeNull();
    expect(resolveSiteMetaTarget({ previewServerUrl: "ftp://x" })).toBeNull();
  });
});

describe("isTrustedSiteOrigin", () => {
  it("accepts only https on the platform domain", () => {
    expect(isTrustedSiteOrigin("https://acme.deco.site")).toBe(true);
    expect(isTrustedSiteOrigin("http://acme.deco.site")).toBe(false);
    expect(isTrustedSiteOrigin("https://deco.site.example.com")).toBe(false);
    expect(isTrustedSiteOrigin("https://acmedeco.site")).toBe(false);
  });
});

describe("buildSiteMetaRequest", () => {
  const trusted = { siteUrl: "https://acme.deco.site/a?b=1", trusted: true };
  const untrusted = { siteUrl: "https://store.example.com", trusted: false };

  it("targets /live/_meta on the site origin, whatever path the URL has", () => {
    expect(buildSiteMetaRequest({ target: trusted }).url).toBe(
      "https://acme.deco.site/live/_meta",
    );
  });

  it("sends the token only to a trusted origin", () => {
    expect(
      buildSiteMetaRequest({ target: trusted, adminToken: "t0ken" }).headers[
        SITE_ADMIN_TOKEN_HEADER
      ],
    ).toBe("t0ken");
    expect(
      buildSiteMetaRequest({ target: untrusted, adminToken: "t0ken" }).headers,
    ).toEqual({ accept: "application/json" });
  });

  it("forwards the etag and ignores empty values", () => {
    expect(
      buildSiteMetaRequest({ target: untrusted, ifNoneMatch: '"abc"' }).headers,
    ).toEqual({ accept: "application/json", "if-none-match": '"abc"' });
    expect(
      buildSiteMetaRequest({ target: trusted, ifNoneMatch: "", adminToken: "" })
        .headers,
    ).toEqual({ accept: "application/json" });
  });
});

describe("isJsonContentType", () => {
  it("accepts JSON types only", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/schema+json")).toBe(true);
    expect(isJsonContentType("text/html")).toBe(false);
    expect(isJsonContentType("text/plain; x=application/json")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });
});

describe("siteMetaResponseHeaders", () => {
  it("is always unsniffable JSON, never cached, and keeps only the etag", () => {
    expect(
      siteMetaResponseHeaders(
        new Headers({
          etag: '"v1"',
          "content-type": "text/html",
          "set-cookie": "session=1",
        }),
      ),
    ).toEqual({
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "no-store",
      etag: '"v1"',
    });
  });

  it("omits a missing etag", () => {
    expect(siteMetaResponseHeaders(new Headers()).etag).toBeUndefined();
  });
});
