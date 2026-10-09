import { describe, expect, test } from "bun:test";
import { reHome } from "./store-url";

const STORE = "https://loja.com.br";

describe("reHome", () => {
  test("moves a leaked platform host onto the store's domain", () => {
    expect(
      reHome("https://acme.vtexcommercestable.com.br/mochila-escolar/p", STORE),
    ).toBe("https://loja.com.br/mochila-escolar/p");
  });

  test("keeps the query, which a PDP address routinely carries", () => {
    expect(
      reHome("https://acme.vtexcommercestable.com.br/x/p?skuId=148129", STORE),
    ).toBe("https://loja.com.br/x/p?skuId=148129");
  });

  test("keeps the hash", () => {
    expect(reHome("https://acme.vtex.com/x/p#reviews", STORE)).toBe(
      "https://loja.com.br/x/p#reviews",
    );
  });

  test("absolutises a relative path", () => {
    expect(reHome("/escolar/mochilas", STORE)).toBe(
      "https://loja.com.br/escolar/mochilas",
    );
  });

  test("leaves a URL alone when no store is configured", () => {
    const url = "https://acme.vtexcommercestable.com.br/x/p";
    expect(reHome(url, "")).toBe(url);
    expect(reHome(url, "   ")).toBe(url);
  });

  test("leaves a URL alone when the store address is unusable", () => {
    const url = "https://acme.vtexcommercestable.com.br/x/p";
    expect(reHome(url, "loja")).toBe(url);
    expect(reHome(url, "javascript:alert(1)")).toBe(url);
  });

  test("an empty input stays empty rather than becoming the store root", () => {
    expect(reHome("", STORE)).toBe("");
    expect(reHome(undefined, STORE)).toBe("");
  });

  test("a store address with a path contributes only its origin", () => {
    expect(reHome("/escolar", "https://loja.com.br/br/pt")).toBe(
      "https://loja.com.br/escolar",
    );
  });
});
