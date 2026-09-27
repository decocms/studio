import { describe, expect, test } from "bun:test";
import { siteLeftBehind } from "./release";

describe("siteLeftBehind", () => {
  test("a new hostname leaves the previous site behind", () => {
    expect(
      siteLeftBehind("https://old-shop.example", "https://new-shop.example"),
    ).toBe("https://old-shop.example");
  });

  test("the engine keeps www, so dropping it is another site", () => {
    expect(
      siteLeftBehind("https://www.shop.example", "https://shop.example"),
    ).toBe("https://www.shop.example");
  });

  test("the same hostname is the same diagnostic, on any port or case", () => {
    expect(
      siteLeftBehind("https://shop.example", "https://shop.example:8443"),
    ).toBeNull();
    expect(
      siteLeftBehind("https://Shop.Example", "https://shop.example"),
    ).toBeNull();
  });

  test("no stored site, or an unusable one, leaves nothing behind", () => {
    expect(siteLeftBehind(undefined, "https://shop.example")).toBeNull();
    expect(siteLeftBehind("", "https://shop.example")).toBeNull();
    expect(siteLeftBehind("not a site", "https://shop.example")).toBeNull();
  });
});
