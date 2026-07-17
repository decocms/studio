import { describe, expect, it } from "bun:test";
import {
  getMutedFromUrl,
  getQualityFromUrl,
  isQuality,
  setMutedOnUrl,
  setQualityOnUrl,
} from "./media-url-params";

describe("quality", () => {
  it("reads a valid quality param from an absolute URL", () => {
    expect(getQualityFromUrl("https://cdn.deco.cx/x.png?quality=high")).toBe(
      "high",
    );
  });

  it("ignores an invalid quality value", () => {
    expect(
      getQualityFromUrl("https://cdn.deco.cx/x.png?quality=ultra"),
    ).toBeUndefined();
  });

  it("returns undefined when absent or url empty", () => {
    expect(getQualityFromUrl("https://cdn.deco.cx/x.png")).toBeUndefined();
    expect(getQualityFromUrl(undefined)).toBeUndefined();
  });

  it("reads from a non-URL string via the raw fallback", () => {
    expect(getQualityFromUrl("/local/x.png?quality=low")).toBe("low");
  });

  it("does not match a quality param that only shares a prefix", () => {
    expect(getQualityFromUrl("/x.png?quality=lowering")).toBeUndefined();
  });

  it("sets, replaces, and clears the param on an absolute URL", () => {
    const base = "https://cdn.deco.cx/x.png";
    const withQ = setQualityOnUrl(base, "medium");
    expect(getQualityFromUrl(withQ)).toBe("medium");
    expect(getQualityFromUrl(setQualityOnUrl(withQ, "original"))).toBe(
      "original",
    );
    expect(setQualityOnUrl(withQ, undefined)).toBe(`${base}`);
  });

  it("sets and clears the param on a non-URL string, preserving other params", () => {
    const set = setQualityOnUrl("/x.png?w=10", "high");
    expect(set).toContain("w=10");
    expect(getQualityFromUrl(set)).toBe("high");
    expect(getQualityFromUrl(setQualityOnUrl(set, undefined))).toBeUndefined();
  });

  it("isQuality narrows all and only valid values", () => {
    expect(isQuality("low")).toBe(true);
    expect(isQuality("original")).toBe(true);
    expect(isQuality("nope")).toBe(false);
    expect(isQuality(null)).toBe(false);
  });
});

describe("muted", () => {
  it("defaults to muted when no param is present", () => {
    expect(getMutedFromUrl("https://cdn.deco.cx/v.mp4")).toBe(true);
    expect(getMutedFromUrl(undefined)).toBe(true);
  });

  it("reads muted=false as unmuted", () => {
    expect(getMutedFromUrl("https://cdn.deco.cx/v.mp4?muted=false")).toBe(
      false,
    );
    expect(getMutedFromUrl("/v.mp4?muted=false")).toBe(false);
  });

  it("writes muted=false only when unmuted and clears it when muted", () => {
    const base = "https://cdn.deco.cx/v.mp4";
    const unmuted = setMutedOnUrl(base, false);
    expect(getMutedFromUrl(unmuted)).toBe(false);
    // Muting is the default → param removed, back to the clean URL.
    expect(setMutedOnUrl(unmuted, true)).toBe(base);
  });

  it("handles the non-URL fallback and leaves sibling params intact", () => {
    const unmuted = setMutedOnUrl("/v.mp4?quality=high", false);
    expect(unmuted).toContain("quality=high");
    expect(getMutedFromUrl(unmuted)).toBe(false);
    expect(getMutedFromUrl(setMutedOnUrl(unmuted, true))).toBe(true);
  });
});
