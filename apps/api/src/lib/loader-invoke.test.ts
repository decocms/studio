import { describe, expect, it } from "bun:test";
import {
  buildLoaderInvokeUrl,
  isValidLoaderResolveType,
  parseLoaderInvokeRequest,
} from "./loader-invoke";

describe("isValidLoaderResolveType", () => {
  it("accepts typical resolveType paths", () => {
    expect(isValidLoaderResolveType("apps/my-app/loaders/products.ts")).toBe(
      true,
    );
    expect(isValidLoaderResolveType("./loaders/foo.ts")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidLoaderResolveType("")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidLoaderResolveType("../../etc/passwd")).toBe(false);
    expect(isValidLoaderResolveType("loaders/../../secrets.ts")).toBe(false);
  });

  it("rejects characters outside the allowed set", () => {
    expect(isValidLoaderResolveType("loaders/foo bar.ts")).toBe(false);
    expect(isValidLoaderResolveType("loaders/foo?bar")).toBe(false);
  });
});

describe("parseLoaderInvokeRequest", () => {
  it("returns null when __resolveType is missing", () => {
    expect(parseLoaderInvokeRequest({})).toBeNull();
  });

  it("returns null when __resolveType is invalid", () => {
    expect(
      parseLoaderInvokeRequest({ __resolveType: "../../etc/passwd" }),
    ).toBeNull();
  });

  it("wraps a props object under a payload.props key", () => {
    const result = parseLoaderInvokeRequest({
      __resolveType: "loaders/foo.ts",
      props: { id: "1" },
    });
    expect(result).toEqual({
      resolveType: "loaders/foo.ts",
      payload: { props: { id: "1" } },
    });
  });

  it("falls back to the remaining top-level fields when props isn't an object", () => {
    const result = parseLoaderInvokeRequest({
      __resolveType: "loaders/foo.ts",
      id: "1",
      qty: 2,
    });
    expect(result).toEqual({
      resolveType: "loaders/foo.ts",
      payload: { id: "1", qty: 2 },
    });
  });

  it("does not treat an array 'props' field as the props object", () => {
    const result = parseLoaderInvokeRequest({
      __resolveType: "loaders/foo.ts",
      props: ["not", "an", "object"],
    });
    expect(result).toEqual({
      resolveType: "loaders/foo.ts",
      payload: { props: ["not", "an", "object"] },
    });
  });

  it("keeps sibling fields next to a nested props key", () => {
    const result = parseLoaderInvokeRequest({
      __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
      props: { ids: ["149524"] },
      simulationBehavior: "default",
    });
    expect(result).toEqual({
      resolveType: "vtex/loaders/intelligentSearch/productList.ts",
      payload: { props: { ids: ["149524"] }, simulationBehavior: "default" },
    });
  });
});

describe("buildLoaderInvokeUrl", () => {
  // The resolveType stays RAW in the path (slashes intact) — the deco runtime
  // routes /deco/invoke/* on the un-decoded path, so a %2F-encoded key 404s.
  it("joins base url and resolveType with slashes intact", () => {
    expect(
      buildLoaderInvokeUrl("https://preview.example.com", "loaders/foo.ts"),
    ).toBe("https://preview.example.com/deco/invoke/loaders/foo.ts");
  });

  it("strips trailing slashes from the base url", () => {
    expect(
      buildLoaderInvokeUrl("https://preview.example.com///", "loaders/foo.ts"),
    ).toBe("https://preview.example.com/deco/invoke/loaders/foo.ts");
  });
});
