import { describe, expect, it } from "bun:test";
import {
  buildSiteMetaRequest,
  isJsonContentType,
  isTrustedSiteOrigin,
  resolveSiteMetaTargets,
  SITE_ADMIN_TOKEN_HEADER,
  siteMetaResponseHeaders,
} from "./site-meta-request";

describe("resolveSiteMetaTargets", () => {
  it("tries the platform host of an owned site, then the preview URL untrusted", () => {
    expect(
      resolveSiteMetaTargets(
        {
          siteSlug: "acme",
          previewServerUrl: "https://attacker.example",
        },
        true,
      ),
    ).toEqual([
      { siteUrl: "https://acme.deco.site/", trusted: true },
      { siteUrl: "https://attacker.example/", trusted: false },
    ]);
  });

  it("cannot be steered off the platform domain through the slug", () => {
    const [target] = resolveSiteMetaTargets(
      { siteSlug: "evil.example/#" },
      true,
    );
    expect(target?.trusted).toBe(true);
    expect(new URL(target!.siteUrl).hostname.endsWith(".deco.site")).toBe(true);
  });

  it("never trusts a slug another org owns, even on the platform domain", () => {
    expect(
      resolveSiteMetaTargets(
        { siteSlug: "victim", previewServerUrl: "https://victim.deco.site" },
        false,
      ),
    ).toEqual([{ siteUrl: "https://victim.deco.site/", trusted: false }]);
    expect(resolveSiteMetaTargets({ siteSlug: "victim" }, false)).toEqual([]);
  });

  it("reads only the editor's preview URL without an owned slug", () => {
    expect(
      resolveSiteMetaTargets(
        { siteSlug: "", productionUrl: "https://store.example.com" },
        true,
      ),
    ).toEqual([{ siteUrl: "https://store.example.com/", trusted: false }]);
  });

  it("is empty without a slug or a preview URL", () => {
    expect(resolveSiteMetaTargets(null, false)).toEqual([]);
    expect(resolveSiteMetaTargets({ siteSlug: 42 }, true)).toEqual([]);
    expect(
      resolveSiteMetaTargets({ previewServerUrl: "ftp://x" }, false),
    ).toEqual([]);
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

  it("forwards a weakened etag as the site issued it", () => {
    expect(
      buildSiteMetaRequest({ target: untrusted, ifNoneMatch: 'W/"abc"' })
        .headers["if-none-match"],
    ).toBe('"abc"');
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
