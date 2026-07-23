import { describe, expect, it } from "bun:test";
import { metaSourceOrder } from "./use-live-meta";

const PREVIEW = "https://sandbox.example.deco.host";
const PROD = "https://www.example.com";

describe("metaSourceOrder", () => {
  it("dev up: live → committed → production", () => {
    expect(
      metaSourceOrder({
        fetchEnabled: true,
        previewUrl: PREVIEW,
        productionUrl: PROD,
      }),
    ).toEqual([
      { kind: "live", baseUrl: PREVIEW },
      { kind: "committed" },
      { kind: "production", baseUrl: PROD },
    ]);
  });

  it("dev down: committed → production (no live attempt)", () => {
    expect(
      metaSourceOrder({
        fetchEnabled: false,
        previewUrl: PREVIEW,
        productionUrl: PROD,
      }),
    ).toEqual([{ kind: "committed" }, { kind: "production", baseUrl: PROD }]);
  });

  it("no previewUrl yet: skips live even when fetchEnabled", () => {
    expect(
      metaSourceOrder({
        fetchEnabled: true,
        previewUrl: null,
        productionUrl: PROD,
      }),
    ).toEqual([{ kind: "committed" }, { kind: "production", baseUrl: PROD }]);
  });

  it("no production configured: committed is the only fallback", () => {
    expect(
      metaSourceOrder({
        fetchEnabled: false,
        previewUrl: PREVIEW,
        productionUrl: null,
      }),
    ).toEqual([{ kind: "committed" }]);
  });

  it("committed always precedes production (branch-accurate wins)", () => {
    const order = metaSourceOrder({
      fetchEnabled: true,
      previewUrl: PREVIEW,
      productionUrl: PROD,
    });
    const committedIdx = order.findIndex((s) => s.kind === "committed");
    const productionIdx = order.findIndex((s) => s.kind === "production");
    expect(committedIdx).toBeLessThan(productionIdx);
  });
});
