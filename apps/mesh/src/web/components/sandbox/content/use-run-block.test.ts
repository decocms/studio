import { describe, expect, it } from "bun:test";
import { buildInvokeRunUrl, buildPreviewInvokePath } from "./use-run-block";

const NOW_MS = 1_751_500_000_000;

describe("buildPreviewInvokePath", () => {
  it("builds the org-scoped studio proxy path", () => {
    expect(
      buildPreviewInvokePath({
        orgSlug: "acme",
        virtualMcpId: "vm-1",
        branch: "main",
      }),
    ).toBe("/api/acme/sandbox/vm-1/main/preview-invoke");
  });

  it("encodes slashes in virtualMcpId and branch", () => {
    expect(
      buildPreviewInvokePath({
        orgSlug: "acme",
        virtualMcpId: "vm/one",
        branch: "feature/local-preview",
      }),
    ).toBe("/api/acme/sandbox/vm%2Fone/feature%2Flocal-preview/preview-invoke");
  });
});

describe("buildInvokeRunUrl", () => {
  it("targets /deco/invoke with the resolveType raw in the path (slashes intact)", () => {
    const url = new URL(
      buildInvokeRunUrl(
        "http://handle.localhost:6000",
        "vtex/loaders/intelligentSearch/productList.ts",
        {},
        NOW_MS,
      ),
    );
    expect(url.pathname).toBe(
      "/deco/invoke/vtex/loaders/intelligentSearch/productList.ts",
    );
    expect(url.origin).toBe("http://handle.localhost:6000");
  });

  it("sets the cache-bust / debug search params", () => {
    const url = new URL(
      buildInvokeRunUrl(
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
      buildInvokeRunUrl(
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
