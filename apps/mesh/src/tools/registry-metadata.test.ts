import { describe, expect, it } from "bun:test";
import {
  allCapabilitiesGranted,
  getCapabilitySections,
  resolveCapabilities,
} from "./registry-metadata";

const allCaps = getCapabilitySections().flatMap((s) => s.capabilities);
// A capability with >= 2 tools so we can test partial / split grants.
const sampleCap = allCaps.find((c) => c.tools.length >= 2);
if (!sampleCap) {
  throw new Error("expected at least one gated capability with >= 2 tools");
}
const sampleTools = sampleCap.tools;

describe("resolveCapabilities", () => {
  it("grants no gated capability for an empty permission", () => {
    const result = resolveCapabilities({});
    expect(Object.keys(result).length).toBeGreaterThan(0);
    expect(Object.values(result).every((v) => v === false)).toBe(true);
  });

  it("never includes the hidden basic-usage capability", () => {
    expect("basic-usage" in resolveCapabilities({ self: ["*"] })).toBe(false);
    expect("basic-usage" in resolveCapabilities({})).toBe(false);
  });

  it("grants a capability when all its tools are present", () => {
    const result = resolveCapabilities({ self: [...sampleTools] });
    expect(result[sampleCap.id]).toBe(true);
  });

  it("does not grant a capability when only some of its tools are present", () => {
    const partial = sampleTools.slice(0, -1); // drop one
    const result = resolveCapabilities({ self: partial });
    expect(result[sampleCap.id]).toBe(false);
  });

  it("aggregates tools across resource buckets", () => {
    // Same tools, split between self and a connection bucket, still count.
    const result = resolveCapabilities({
      self: sampleTools.slice(0, 1),
      conn_x: sampleTools.slice(1),
    });
    expect(result[sampleCap.id]).toBe(true);
  });

  it("grants every gated capability for a self wildcard", () => {
    const result = resolveCapabilities({ self: ["*"] });
    expect(Object.values(result).every((v) => v === true)).toBe(true);
  });

  it("grants every gated capability for an org-wide wildcard", () => {
    const result = resolveCapabilities({ "*": ["*"] });
    expect(Object.values(result).every((v) => v === true)).toBe(true);
  });
});

describe("allCapabilitiesGranted", () => {
  it("returns every gated capability as true, excluding basic-usage", () => {
    const result = allCapabilitiesGranted();
    expect(Object.values(result).every((v) => v === true)).toBe(true);
    expect("basic-usage" in result).toBe(false);
  });

  it("covers exactly the same capability ids as resolveCapabilities", () => {
    expect(Object.keys(allCapabilitiesGranted()).sort()).toEqual(
      Object.keys(resolveCapabilities({})).sort(),
    );
  });
});
