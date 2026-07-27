import { describe, expect, it } from "bun:test";
import { applyModelAllowList } from "./preferences-update";

const A = { keyId: "k1", modelId: "allowed" };
const B = { keyId: "k1", modelId: "denied" };
const ALLOWED = ["k1:allowed"];

describe("applyModelAllowList", () => {
  it("passes everything through when the role has no model restriction", () => {
    expect(applyModelAllowList({ smart: B }, undefined, undefined)).toEqual({
      fast: undefined,
      smart: B,
      thinking: undefined,
    });
  });

  it("keeps an allowed pick", () => {
    expect(applyModelAllowList({ smart: A }, undefined, ALLOWED).smart).toEqual(
      A,
    );
  });

  it("rejects a newly picked disallowed model", () => {
    expect(() => applyModelAllowList({ smart: B }, undefined, ALLOWED)).toThrow(
      "Model not allowed for your role",
    );
  });

  it("rejects a changed slot even when the old one was also disallowed", () => {
    expect(() =>
      applyModelAllowList(
        { smart: { keyId: "k2", modelId: "denied" } },
        { smart: B },
        ALLOWED,
      ),
    ).toThrow("Model not allowed for your role");
  });

  it("drops an unchanged now-disallowed slot instead of throwing", () => {
    // Role narrowed after the user saved B: the write must succeed and B must
    // stop taking effect (null = fall back to the org default).
    expect(applyModelAllowList({ smart: B }, { smart: B }, ALLOWED)).toEqual({
      fast: undefined,
      smart: null,
      thinking: undefined,
    });
  });

  it("does not let residue in one tier block editing another", () => {
    const result = applyModelAllowList(
      { fast: B, smart: A },
      { fast: B },
      ALLOWED,
    );
    expect(result.fast).toBeNull();
    expect(result.smart).toEqual(A);
  });

  it("passes an explicit null (reset) through untouched", () => {
    expect(applyModelAllowList({ smart: null }, { smart: B }, ALLOWED)).toEqual(
      {
        fast: undefined,
        smart: null,
        thinking: undefined,
      },
    );
  });
});
