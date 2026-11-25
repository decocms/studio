import { describe, expect, it } from "bun:test";
import {
  addDomain,
  canSave,
  cleanList,
  normalizeDraft,
} from "./competitors-field.ts";

describe("normalizeDraft", () => {
  it("keeps the host of a pasted URL, lowercased", () => {
    expect(normalizeDraft("https://WWW.Loja.example/p")).toBe(
      "www.loja.example",
    );
    expect(normalizeDraft("  http://loja.example?x=1  ")).toBe("loja.example");
  });

  it("is null for what is not a domain", () => {
    expect(normalizeDraft("loja")).toBeNull();
    expect(normalizeDraft("")).toBeNull();
    expect(normalizeDraft("   ")).toBeNull();
    expect(normalizeDraft("loja .example")).toBeNull();
    expect(normalizeDraft("!!.example")).toBeNull();
  });
});

describe("addDomain", () => {
  it("adds the normalized domain at the end", () => {
    expect(addDomain(["a.example"], " https://B.example/x ")).toEqual({
      list: ["a.example", "b.example"],
      error: null,
    });
  });

  it("refuses what is not a domain and keeps the list", () => {
    expect(addDomain(["a.example"], "loja")).toEqual({
      list: ["a.example"],
      error: "invalid",
    });
  });

  it("refuses the same store with or without www.", () => {
    expect(addDomain(["loja.example"], "loja.example").error).toBe("duplicate");
    expect(addDomain(["loja.example"], "www.loja.example")).toEqual({
      list: ["loja.example"],
      error: "duplicate",
    });
    expect(addDomain(["www.loja.example"], "https://loja.example/").error).toBe(
      "duplicate",
    );
  });
});

describe("cleanList", () => {
  it("normalizes, keeps one per store and drops what does not parse", () => {
    expect(
      cleanList([
        "https://Rival.example/p",
        "www.rival.example",
        "loja",
        "outra.example",
      ]),
    ).toEqual(["rival.example", "outra.example"]);
    expect(cleanList([])).toEqual([]);
  });
});

describe("canSave", () => {
  it("needs at least one competitor", () => {
    expect(canSave([])).toBe(false);
    expect(canSave(["a.example"])).toBe(true);
  });
});
