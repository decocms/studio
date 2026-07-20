import { describe, expect, test } from "bun:test";
import {
  REDIRECT_RESOLVE_TYPE,
  REDIRECT_STATUS,
  buildRedirectBlock,
  extractRedirects,
  generateRedirectBlockKey,
  getRedirectPayload,
} from "./redirect-data";

test("REDIRECT_STATUS locks the HTTP status contract", () => {
  expect(REDIRECT_STATUS).toEqual({ temporary: 307, permanent: 301 });
});

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
  test("derives a slug from the `from` path, stripping the query string", () => {
    const key = generateRedirectBlockKey({}, "/Bazar-Farm/Short?map=c");
    expect(key.startsWith("redirects-Bazar-Farm-Short-")).toBe(true);
  });

  test("caps the slug at 32 chars for a long `from`", () => {
    const long = `/${"a".repeat(100)}`;
    const key = generateRedirectBlockKey({}, long);
    // key = `redirects-<slug>-<uuid>`; the slug segment is capped at 32.
    const slug = key.slice(
      "redirects-".length,
      -"-00000000-0000-0000-0000-000000000000".length,
    );
    expect(slug).toBe("a".repeat(32));
  });

  test("falls back to a stable slug for empty / rootish / all-special `from`", () => {
    for (const from of ["/", "", "   ", "/@#$%"]) {
      expect(
        generateRedirectBlockKey({}, from).startsWith("redirects-redirect-"),
      ).toBe(true);
    }
  });

  test("returns a distinct key for the same `from` (uniqueness guard)", () => {
    // Exercises the collision-retry loop: seed the decofile with a key, then
    // confirm two fresh generations for the same `from` never collide.
    const decofile: Record<string, unknown> = {};
    const first = generateRedirectBlockKey(decofile, "/x");
    decofile[first] = { __resolveType: REDIRECT_RESOLVE_TYPE };
    const second = generateRedirectBlockKey(decofile, "/x");
    expect(second).not.toBe(first);
    expect(Object.hasOwn(decofile, second)).toBe(false);
  });
});
