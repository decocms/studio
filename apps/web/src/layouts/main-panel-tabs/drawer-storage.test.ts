import { describe, expect, it } from "bun:test";
import { parseDrawerState, parseTerminalOverride } from "./drawer-storage";

describe("parseDrawerState", () => {
  it("defaults to closed with no height for a missing value", () => {
    expect(parseDrawerState(null)).toEqual({ open: false, height: null });
  });

  it("reads open + height", () => {
    expect(
      parseDrawerState(JSON.stringify({ open: true, height: 300 })),
    ).toEqual({ open: true, height: 300 });
  });

  it("tolerates the legacy height-less shape", () => {
    expect(parseDrawerState(JSON.stringify({ open: true }))).toEqual({
      open: true,
      height: null,
    });
  });

  it("drops a non-number height", () => {
    expect(
      parseDrawerState(JSON.stringify({ open: true, height: "300" })),
    ).toEqual({ open: true, height: null });
  });

  it("coerces a truthy/falsy open", () => {
    expect(parseDrawerState(JSON.stringify({ open: 0, height: 200 }))).toEqual({
      open: false,
      height: 200,
    });
  });

  it("falls back on malformed JSON", () => {
    expect(parseDrawerState("{not json")).toEqual({
      open: false,
      height: null,
    });
  });
});

describe("parseTerminalOverride", () => {
  it("returns null for a missing value (→ use default preference)", () => {
    expect(parseTerminalOverride(null)).toBeNull();
  });

  it("returns an explicit true override", () => {
    expect(parseTerminalOverride(JSON.stringify({ visible: true }))).toBe(true);
  });

  it("returns an explicit false override (a per-VM Hide beats the default)", () => {
    expect(parseTerminalOverride(JSON.stringify({ visible: false }))).toBe(
      false,
    );
  });

  it("returns null when `visible` is absent or non-boolean", () => {
    expect(parseTerminalOverride(JSON.stringify({}))).toBeNull();
    expect(
      parseTerminalOverride(JSON.stringify({ visible: "yes" })),
    ).toBeNull();
  });

  it("falls back to null on malformed JSON", () => {
    expect(parseTerminalOverride("{not json")).toBeNull();
  });
});
