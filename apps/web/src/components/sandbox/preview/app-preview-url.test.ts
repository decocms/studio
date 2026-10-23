import { describe, expect, test } from "bun:test";
import {
  appLabel,
  appPreviewUrl,
  appSlug,
  normalizeAppPath,
  withPagePath,
} from "./app-preview-url";

describe("appSlug", () => {
  test("joins path segments into one DNS label", () => {
    expect(appSlug("apps/checkout")).toBe("apps-checkout");
    expect(appSlug("/Apps/My_Store/")).toBe("apps-my-store");
  });

  test("is empty for a path with no usable characters", () => {
    expect(appSlug("///")).toBe("");
  });
});

describe("appLabel", () => {
  test("uses the last segment", () => {
    expect(appLabel("apps/checkout/")).toBe("checkout");
    expect(appLabel("storefront")).toBe("storefront");
  });
});

describe("appPreviewUrl", () => {
  test("suffixes the handle label on a hosted preview", () => {
    expect(
      appPreviewUrl("https://abc123.preview.example.test/", "apps/checkout"),
    ).toBe("https://abc123--apps-checkout.preview.example.test/");
  });

  test("uses a localhost subdomain for loopback, keeping the port", () => {
    expect(appPreviewUrl("http://127.0.0.1:41234/", "apps/admin")).toBe(
      "http://apps-admin.localhost:41234/",
    );
    expect(appPreviewUrl("http://localhost:3000/x?y=1", "web")).toBe(
      "http://web.localhost:3000/",
    );
    expect(appPreviewUrl("http://site.localhost:3000/", "web")).toBe(
      "http://web.site.localhost:3000/",
    );
  });

  test("is null for an invalid base, a bare host, or an empty slug", () => {
    expect(appPreviewUrl("not a url", "web")).toBeNull();
    expect(appPreviewUrl("http://intranet/", "web")).toBeNull();
    expect(appPreviewUrl("https://a.example.test/", "//")).toBeNull();
  });
});

describe("withPagePath", () => {
  test("sets the path and query of the pane", () => {
    expect(withPagePath("https://a.example.test/", "cart?step=2")).toBe(
      "https://a.example.test/cart?step=2",
    );
    expect(withPagePath("https://a.example.test/", "")).toBe(
      "https://a.example.test/",
    );
  });
});

describe("normalizeAppPath", () => {
  test("drops a leading ./ or / and trailing slashes", () => {
    expect(normalizeAppPath(" ./apps/web/ ")).toBe("apps/web");
    expect(normalizeAppPath("/apps/web")).toBe("apps/web");
    expect(normalizeAppPath("  ")).toBe("");
  });
});
