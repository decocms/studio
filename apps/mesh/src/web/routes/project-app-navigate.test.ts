import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { resolveAppNavigateTarget } from "@/web/routes/project-app-navigate.ts";

function navigateBlock(uri: string): ContentBlock[] {
  return [{ type: "resource_link", name: "navigate", uri }];
}

describe("resolveAppNavigateTarget", () => {
  test("navigates to an allowlisted tab", () => {
    expect(
      resolveAppNavigateTarget(navigateBlock("studio://navigate?main=board")),
    ).toEqual({ isNavigate: true, tab: "board" });
    expect(
      resolveAppNavigateTarget(navigateBlock("studio://navigate?main=files")),
    ).toEqual({ isNavigate: true, tab: "files" });
  });

  test("drops the request instead of navigating when the tab isn't allowlisted", () => {
    // Guards against an app driving navigation to an arbitrary tab.
    expect(
      resolveAppNavigateTarget(
        navigateBlock("studio://navigate?main=settings"),
      ),
    ).toEqual({ isNavigate: true, tab: null });
  });

  test("drops the request when the URI is malformed", () => {
    expect(
      resolveAppNavigateTarget(navigateBlock("studio://navigate??main")),
    ).toEqual({ isNavigate: true, tab: null });
  });

  test("drops the request when main is missing", () => {
    expect(
      resolveAppNavigateTarget(navigateBlock("studio://navigate")),
    ).toEqual({ isNavigate: true, tab: null });
  });

  test("is not a navigate message for a different scheme", () => {
    expect(
      resolveAppNavigateTarget(navigateBlock("https://example.com?main=board")),
    ).toEqual({ isNavigate: false });
  });

  test("is not a navigate message for non-resource_link content", () => {
    expect(resolveAppNavigateTarget([{ type: "text", text: "hello" }])).toEqual(
      { isNavigate: false },
    );
  });

  test("is not a navigate message when there's more than one content block", () => {
    expect(
      resolveAppNavigateTarget([
        {
          type: "resource_link",
          name: "navigate",
          uri: "studio://navigate?main=board",
        },
        { type: "text", text: "extra" },
      ]),
    ).toEqual({ isNavigate: false });
  });
});
