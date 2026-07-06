import { describe, expect, it } from "bun:test";
import { buildPreviewRunUrl } from "./use-run-block";

const NOW_MS = 1_751_500_000_000;

describe("buildPreviewRunUrl", () => {
  it("keeps the resolveType raw in the path (slashes intact)", () => {
    const url = new URL(
      buildPreviewRunUrl(
        "http://handle.localhost:6000",
        "vtex/loaders/intelligentSearch/productList.ts",
        {},
        NOW_MS,
      ),
    );
    expect(url.pathname).toBe(
      "/live/previews/vtex/loaders/intelligentSearch/productList.ts",
    );
    expect(url.origin).toBe("http://handle.localhost:6000");
  });

  it("sets the cache-bust / debug search params", () => {
    const url = new URL(
      buildPreviewRunUrl(
        "http://handle.localhost:6000/",
        "site/loaders/products.ts",
        {},
        NOW_MS,
      ),
    );
    const cb = NOW_MS.toString(36);
    expect(url.searchParams.get("__cb")).toBe(cb);
    expect(url.searchParams.get("__decoFBT")).toBe("0");
    expect(url.searchParams.get("__d")).toBe(`run-${cb}`);
  });

  it("round-trips props through the admin encodeProps encoding", () => {
    const props = {
      term: "cadeira de praia", // unicode — the reason for encodeURIComponent
      ids: ["149524", "149525"],
      hideUnavailableItems: true,
      nested: { emoji: "🏖️" },
    };
    const url = new URL(
      buildPreviewRunUrl(
        "http://handle.localhost:6000",
        "site/loaders/products.ts",
        props,
        NOW_MS,
      ),
    );
    const encoded = url.searchParams.get("props");
    expect(encoded).toBeTruthy();
    // The deco runtime decodes with `decodeURIComponent(atob(props))`.
    expect(JSON.parse(decodeURIComponent(atob(encoded!)))).toEqual(props);
  });
});
