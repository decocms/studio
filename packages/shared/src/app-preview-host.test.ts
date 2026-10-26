import { describe, expect, test } from "bun:test";
import { appHostLabel, parseAppHostLabel } from "./app-preview-host";

describe("app preview host", () => {
  test("puts the app after the handle and parses it back", () => {
    const label = appHostLabel("main-0123abcd", "apps/Checkout");
    expect(label).toBe("main-0123abcd--apps-checkout");
    expect(parseAppHostLabel(label)).toEqual({
      handle: "main-0123abcd",
      slug: "apps-checkout",
    });
  });

  test("a plain handle names the main app", () => {
    expect(parseAppHostLabel("main-0123abcd")).toEqual({
      handle: "main-0123abcd",
      slug: null,
    });
    expect(parseAppHostLabel("--x")).toEqual({ handle: "--x", slug: null });
  });
});
