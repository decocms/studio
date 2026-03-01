import { describe, expect, it } from "bun:test";
import {
  MCP_APP_DISPLAY_MODES,
  RESOURCE_MIME_TYPE,
  getUIResourceUri,
  isUIResourceUri,
} from "./types.ts";

describe("SDK re-exports", () => {
  it("RESOURCE_MIME_TYPE matches spec", () => {
    expect(RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
  });
});

describe("getUIResourceUri", () => {
  it("extracts URI from nested meta format", () => {
    expect(getUIResourceUri({ ui: { resourceUri: "ui://self/counter" } })).toBe(
      "ui://self/counter",
    );
  });
  it("extracts URI from deprecated flat meta format", () => {
    expect(getUIResourceUri({ "ui/resourceUri": "ui://counter" })).toBe(
      "ui://counter",
    );
  });
  it("returns undefined for null", () => {
    expect(getUIResourceUri(null)).toBeUndefined();
  });
  it("returns undefined when key missing", () => {
    expect(getUIResourceUri({ other: "value" })).toBeUndefined();
  });
  it("returns undefined for invalid resourceUri", () => {
    expect(
      getUIResourceUri({ ui: { resourceUri: "not-a-uri" } }),
    ).toBeUndefined();
  });
});

describe("isUIResourceUri", () => {
  it("returns true for ui:// URIs", () => {
    expect(isUIResourceUri("ui://counter")).toBe(true);
    expect(isUIResourceUri("ui://mesh/greeting")).toBe(true);
    expect(isUIResourceUri("ui://self/code?borderless=true")).toBe(true);
  });
  it("returns false for http URIs", () => {
    expect(isUIResourceUri("http://example.com")).toBe(false);
  });
  it("returns false for https URIs", () => {
    expect(isUIResourceUri("https://example.com")).toBe(false);
  });
  it("returns false for legacy /_widgets/ paths", () => {
    expect(isUIResourceUri("/_widgets/counter")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(isUIResourceUri("")).toBe(false);
  });
});

describe("MCP_APP_DISPLAY_MODES", () => {
  it("defines collapsed mode", () => {
    expect(MCP_APP_DISPLAY_MODES.collapsed.minHeight).toBe(150);
    expect(MCP_APP_DISPLAY_MODES.collapsed.maxHeight).toBe(300);
  });
  it("defines expanded mode", () => {
    expect(MCP_APP_DISPLAY_MODES.expanded.minHeight).toBe(300);
    expect(MCP_APP_DISPLAY_MODES.expanded.maxHeight).toBe(600);
  });
  it("defines view mode", () => {
    expect(MCP_APP_DISPLAY_MODES.view.minHeight).toBe(400);
    expect(MCP_APP_DISPLAY_MODES.view.maxHeight).toBe(800);
  });
  it("defines fullscreen mode", () => {
    expect(MCP_APP_DISPLAY_MODES.fullscreen.minHeight).toBe(600);
    expect(MCP_APP_DISPLAY_MODES.fullscreen.maxHeight).toBe(1200);
  });
});
