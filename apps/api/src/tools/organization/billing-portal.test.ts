import { describe, expect, test } from "bun:test";
import { normalizeSiteHost } from "./billing-portal";

describe("normalizeSiteHost", () => {
  test("accepts hosts and full URLs, lowercases, strips path/scheme", () => {
    expect(normalizeSiteHost("shop.example.com")).toBe("shop.example.com");
    expect(normalizeSiteHost("https://Shop.Example.com/deck?x=1")).toBe(
      "shop.example.com",
    );
    expect(normalizeSiteHost("http://www.loja.com.br")).toBe("www.loja.com.br");
  });

  test("rejects garbage and dotless hosts", () => {
    expect(normalizeSiteHost("not a url")).toBeNull();
    expect(normalizeSiteHost("localhost")).toBeNull();
    expect(normalizeSiteHost("https://")).toBeNull();
  });
});
