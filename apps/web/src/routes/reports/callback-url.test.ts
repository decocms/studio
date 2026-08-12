import { afterEach, describe, expect, test } from "bun:test";
import { callbackUrl } from "./callback-url";

// The pattern Better Auth 1.4.22 applies to a relative `callbackURL`
// (matchesOriginPattern, allowRelativePaths branch). Copied verbatim so this
// test fails loudly if an upgrade widens or narrows it — that is the contract
// callbackUrl() has to satisfy, and every value below is checked against it.
const BETTER_AUTH_RELATIVE =
  /^\/(?!\/|\\|%2f|%5c)[\w\-.\+/@]*(?:\?[\w\-.\+/=&%@]*)?$/;

// The module reads `window.location` and falls back to a bare path when there
// is no window (SSR), so the test provides one.
const g = globalThis as {
  window?: { location: { search: string; hash: string } };
};
const setLocation = (search: string, hash: string) => {
  g.window = { location: { search, hash } };
};

afterEach(() => {
  g.window = undefined;
});

describe("callbackUrl", () => {
  test("a shared deck link survives — and Better Auth accepts it", () => {
    // The link people actually click: the raw ':' in share_id is what made
    // signIn.social throw "Invalid callbackURL" and the button look dead.
    setLocation(
      "?share_id=store.example:cta:7jvq0tag&utm_source=share&utm_medium=deck",
      "#cta",
    );
    const url = callbackUrl("store.example");
    expect(url).toMatch(BETTER_AUTH_RELATIVE);
    // attribution is preserved (track.ts reads share_id/utm_* back)
    const query = new URLSearchParams(url.split("?")[1]);
    expect(query.get("share_id")).toBe("store.example:cta:7jvq0tag");
    expect(query.get("utm_medium")).toBe("deck");
    // the anchor is gone: no encoding of '#' can satisfy an anchored pattern
    expect(url).not.toContain("#");
  });

  test("a bare anchor no longer breaks sign-in", () => {
    // Reported failing with no query string at all — the '#' alone was enough.
    setLocation("", "#cover");
    expect(callbackUrl("store.example")).toBe("/report/store.example");
  });

  test("an already-encoded share link stays valid", () => {
    setLocation("?share_id=store.example%3Acta%3Aabc", "");
    const url = callbackUrl("store.example");
    expect(url).toMatch(BETTER_AUTH_RELATIVE);
    expect(new URLSearchParams(url.split("?")[1]).get("share_id")).toBe(
      "store.example:cta:abc",
    );
  });

  test("no query and no hash is unchanged", () => {
    setLocation("", "");
    expect(callbackUrl("store.example")).toBe("/report/store.example");
  });

  test("a domain that survives no encoding falls back to the home path", () => {
    setLocation("", "");
    // encodeURIComponent leaves a '%', which the pattern's PATH class excludes;
    // landing on home beats handing Better Auth a URL it rejects.
    const url = callbackUrl("stör e.example");
    expect(url).toMatch(BETTER_AUTH_RELATIVE);
    expect(url).toBe("/");
  });
});
