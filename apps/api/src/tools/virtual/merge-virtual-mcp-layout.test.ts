import { describe, expect, test } from "bun:test";
import type { VirtualMcpUILayout } from "@decocms/shared/sdk/types";
import { mergeVirtualMcpLayout } from "./merge-virtual-mcp-layout";

describe("mergeVirtualMcpLayout", () => {
  test("preserves every stored field outside the partial patch", () => {
    const tabs = [
      {
        id: "orders",
        title: "Orders",
        view: { type: "ext-app", appId: "commerce" },
      },
    ] satisfies NonNullable<VirtualMcpUILayout["tabs"]>;
    const current = {
      cms: "off",
      tabs,
      sidebarViews: ["assets", "analytics"],
      futureLayoutSetting: { enabled: true },
      chatDefaultOpen: true,
    } satisfies VirtualMcpUILayout & Record<string, unknown>;

    expect(mergeVirtualMcpLayout(current, { chatDefaultOpen: false })).toEqual({
      cms: "off",
      tabs,
      sidebarViews: ["assets", "analytics"],
      futureLayoutSetting: { enabled: true },
      chatDefaultOpen: false,
    });
  });

  test("an omitted patch leaves the prior layout untouched", () => {
    const current = {
      cms: "on",
      sidebarViews: ["hosting"],
    } satisfies VirtualMcpUILayout & Record<string, unknown>;

    expect(mergeVirtualMcpLayout(current, undefined)).toBe(current);
    expect(mergeVirtualMcpLayout(undefined, undefined)).toBeNull();
  });

  test("a patch replaces a non-object prior layout", () => {
    const patch = {
      sidebarViews: ["cdn"],
    } satisfies VirtualMcpUILayout;

    for (const current of [null, "legacy", 42, ["assets"]]) {
      expect(mergeVirtualMcpLayout(current, patch)).toEqual(patch);
    }
  });
});
