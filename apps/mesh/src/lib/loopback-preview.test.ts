import { describe, expect, test } from "bun:test";
import { loopbackPreviewTarget } from "./loopback-preview";

describe("loopbackPreviewTarget", () => {
  test("rewrites a .localhost subdomain to loopback, keeping port and path", () => {
    expect(
      loopbackPreviewTarget(
        "http://sandbox-40f2db77f043bc81.localhost:64506/deco/invoke/x",
      ),
    ).toEqual({
      url: "http://127.0.0.1:64506/deco/invoke/x",
      hostHeader: "sandbox-40f2db77f043bc81.localhost:64506",
    });
  });

  test("leaves plain localhost alone (getaddrinfo resolves it)", () => {
    expect(loopbackPreviewTarget("http://localhost:8000/x")).toBeNull();
  });

  test("leaves public hosts alone", () => {
    expect(
      loopbackPreviewTarget("https://foo.preview-studio.decocms.com/x"),
    ).toBeNull();
  });

  test("returns null for unparseable URLs", () => {
    expect(loopbackPreviewTarget("not a url")).toBeNull();
  });
});
