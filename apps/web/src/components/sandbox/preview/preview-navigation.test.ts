import { describe, expect, it } from "bun:test";
import {
  PREVIEW_NAVIGATED_MESSAGE,
  parsePreviewNavigatedPath,
} from "./preview-navigation";

const msg = (path: unknown) => ({ type: PREVIEW_NAVIGATED_MESSAGE, path });

describe("parsePreviewNavigatedPath", () => {
  it("accepts an absolute path and drops query and hash", () => {
    expect(parsePreviewNavigatedPath(msg("/calcado"))).toBe("/calcado");
    expect(parsePreviewNavigatedPath(msg("/tenis-x/p?skuId=1#top"))).toBe(
      "/tenis-x/p",
    );
    expect(parsePreviewNavigatedPath(msg("/"))).toBe("/");
  });

  it("rejects anything that is not a same-origin path", () => {
    for (const path of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example",
      "calcado",
      "",
      "x".repeat(3000),
      42,
    ]) {
      expect(parsePreviewNavigatedPath(msg(path))).toBeNull();
    }
  });

  it("ignores other message types and shapes", () => {
    expect(
      parsePreviewNavigatedPath({ type: "cms-editor::render-end", path: "/" }),
    ).toBeNull();
    expect(parsePreviewNavigatedPath(null)).toBeNull();
    expect(parsePreviewNavigatedPath("/calcado")).toBeNull();
  });
});
