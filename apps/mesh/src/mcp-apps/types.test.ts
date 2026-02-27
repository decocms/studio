import { describe, expect, it } from "bun:test";
import {
  MCP_APP_DISPLAY_MODES,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  getUIResourceUri,
  hasUIResource,
  isUIResourceUri,
} from "./types.ts";

describe("SDK re-exports", () => {
  it("RESOURCE_MIME_TYPE matches spec", () => {
    expect(RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
  });
  it("RESOURCE_URI_META_KEY matches spec", () => {
    expect(RESOURCE_URI_META_KEY).toBe("ui/resourceUri");
  });
});

describe("hasUIResource", () => {
  it("returns true when meta has ui/resourceUri string", () => {
    expect(hasUIResource({ "ui/resourceUri": "ui://counter" })).toBe(true);
  });
  it("returns false for null", () => {
    expect(hasUIResource(null)).toBe(false);
  });
  it("returns false for undefined", () => {
    expect(hasUIResource(undefined)).toBe(false);
  });
  it("returns false for non-object", () => {
    expect(hasUIResource("string")).toBe(false);
  });
  it("returns false when key missing", () => {
    expect(hasUIResource({ other: "value" })).toBe(false);
  });
  it("returns false when value is not string", () => {
    expect(hasUIResource({ "ui/resourceUri": 123 })).toBe(false);
  });
});

describe("getUIResourceUri", () => {
  it("extracts URI from meta", () => {
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
});

describe("isUIResourceUri", () => {
  it("returns true for ui:// URIs", () => {
    expect(isUIResourceUri("ui://counter")).toBe(true);
    expect(isUIResourceUri("ui://mesh/greeting")).toBe(true);
  });
  it("returns false for http URIs", () => {
    expect(isUIResourceUri("http://example.com")).toBe(false);
  });
  it("returns false for https URIs", () => {
    expect(isUIResourceUri("https://example.com")).toBe(false);
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
