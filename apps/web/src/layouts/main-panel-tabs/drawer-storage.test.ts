import { describe, expect, it } from "bun:test";
import { parseDrawerState } from "./drawer-storage";

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
