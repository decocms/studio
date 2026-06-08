import { describe, expect, it } from "bun:test";
import { shouldRenderInlineModeRow } from "./input-mode-row";

describe("shouldRenderInlineModeRow", () => {
  it("renders on the home composer even before a thread exists", () => {
    expect(
      shouldRenderInlineModeRow({
        messageCount: 0,
        showConnectionsBanner: true,
      }),
    ).toBe(true);
  });

  it("renders inside active threads once messages exist", () => {
    expect(
      shouldRenderInlineModeRow({
        messageCount: 1,
        showConnectionsBanner: false,
      }),
    ).toBe(true);
  });

  it("does not render in an empty task composer with an above-row picker", () => {
    expect(
      shouldRenderInlineModeRow({
        messageCount: 0,
        showConnectionsBanner: false,
      }),
    ).toBe(false);
  });
});
