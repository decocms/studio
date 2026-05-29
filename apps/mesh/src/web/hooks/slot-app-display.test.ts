import { describe, expect, it } from "bun:test";
import type { RegistryItem } from "@/web/components/store/types";
import { slotAppDisplay } from "./slot-app-display";

describe("slotAppDisplay", () => {
  it("falls back to the raw app_id when there is no registry item", () => {
    expect(slotAppDisplay("url:api.acme.com/mcp", null)).toEqual({
      kind: "fallback",
      title: "url:api.acme.com/mcp",
      icon: null,
    });
  });

  it("uses the registry friendly name and icon when present", () => {
    const item = {
      _meta: { "mcp.mesh": { friendlyName: "GitHub" } },
      server: { icons: [{ src: "https://cdn/github.png" }] },
    } as unknown as RegistryItem;
    expect(slotAppDisplay("deco/mcp-github", item)).toEqual({
      kind: "registry",
      title: "GitHub",
      icon: "https://cdn/github.png",
    });
  });

  it("falls through to server.title and null icon when friendly name/icon are missing", () => {
    const item = {
      _meta: {},
      server: { title: "Linear MCP" },
    } as unknown as RegistryItem;
    expect(slotAppDisplay("deco/mcp-linear", item)).toEqual({
      kind: "registry",
      title: "Linear MCP",
      icon: null,
    });
  });
});
