import { describe, expect, test } from "bun:test";
import {
  REDIRECT_RESOLVE_TYPE,
  buildRedirectBlock,
  extractRedirects,
  generateRedirectBlockKey,
  getRedirectPayload,
} from "./redirect-data";

const redirectBlock = (
  redirect: Record<string, unknown>,
): Record<string, unknown> => ({
  redirect,
  __resolveType: REDIRECT_RESOLVE_TYPE,
});

describe("extractRedirects", () => {
  test("picks only redirect blocks and narrows fields", () => {
    const decofile = {
      "redirects-a-1": redirectBlock({
        from: "/old",
        to: "/new",
        type: "permanent",
        discardQueryParameters: true,
      }),
      "redirects-b-2": redirectBlock({ from: "/tmp", to: "/dest" }),
      "pages-home-x": { path: "/", __resolveType: "website/pages/Page.tsx" },
      site: { __resolveType: "site/apps/site.ts" },
    };
    const redirects = extractRedirects(decofile).sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    expect(redirects).toEqual([
      {
        key: "redirects-a-1",
        from: "/old",
        to: "/new",
        type: "permanent",
        discardQueryParameters: true,
      },
      {
        key: "redirects-b-2",
        from: "/tmp",
        to: "/dest",
        type: "temporary",
        discardQueryParameters: false,
      },
    ]);
  });

  test("defaults an unknown type to temporary and tolerates a malformed redirect", () => {
    const decofile = {
      "redirects-weird": redirectBlock({ from: "/x", to: "/y", type: "301" }),
      "redirects-broken": {
        redirect: "nope",
        __resolveType: REDIRECT_RESOLVE_TYPE,
      },
    };
    const byKey = Object.fromEntries(
      extractRedirects(decofile).map((r) => [r.key, r]),
    );
    expect(byKey["redirects-weird"]?.type).toBe("temporary");
    expect(byKey["redirects-broken"]).toEqual({
      key: "redirects-broken",
      from: "",
      to: "",
      type: "temporary",
      discardQueryParameters: false,
    });
  });

  test("ignores arrays and null values without throwing", () => {
    const decofile = {
      arr: [1, 2, 3],
      nope: null,
      "redirects-ok": redirectBlock({ from: "/a", to: "/b" }),
    } as unknown as Record<string, unknown>;
    expect(extractRedirects(decofile).map((r) => r.key)).toEqual([
      "redirects-ok",
    ]);
  });
});

describe("buildRedirectBlock / getRedirectPayload round-trip", () => {
  test("omits discardQueryParameters when false", () => {
    const block = buildRedirectBlock({
      from: "/a",
      to: "/b",
      type: "temporary",
      discardQueryParameters: false,
    });
    expect(block).toEqual({
      redirect: { from: "/a", to: "/b", type: "temporary" },
      __resolveType: REDIRECT_RESOLVE_TYPE,
    });
    expect(getRedirectPayload(block)).toEqual({
      from: "/a",
      to: "/b",
      type: "temporary",
      discardQueryParameters: false,
    });
  });

  test("keeps discardQueryParameters when true", () => {
    const block = buildRedirectBlock({
      from: "/a",
      to: "/b",
      type: "permanent",
      discardQueryParameters: true,
    });
    expect(
      (block.redirect as Record<string, unknown>).discardQueryParameters,
    ).toBe(true);
    expect(getRedirectPayload(block).discardQueryParameters).toBe(true);
  });
});

describe("generateRedirectBlockKey", () => {
  test("derives a slug from the `from` path and never collides", () => {
    const key = generateRedirectBlockKey({}, "/Bazar-Farm/Short?map=c");
    expect(key.startsWith("redirects-Bazar-Farm-Short-")).toBe(true);
  });

  test("falls back to a stable slug for a rootish path", () => {
    expect(
      generateRedirectBlockKey({}, "/").startsWith("redirects-redirect-"),
    ).toBe(true);
    expect(
      generateRedirectBlockKey({}, "").startsWith("redirects-redirect-"),
    ).toBe(true);
  });
});
