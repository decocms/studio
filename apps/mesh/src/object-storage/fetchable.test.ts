import { describe, expect, it } from "bun:test";
import { assertFetchableUrl } from "./fetchable";

describe("assertFetchableUrl", () => {
  it("passes through an http(s) url", () => {
    expect(assertFetchableUrl("https://s3.example.com/x")).toBe(
      "https://s3.example.com/x",
    );
  });
  it("throws on a data: url", () => {
    expect(() => assertFetchableUrl("data:image/png;base64,AAAA")).toThrow(
      /not fetchable/i,
    );
  });
});
