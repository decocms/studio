import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverEndpoint, mcpIdFromUrl, withMcpId } from "./endpoint.js";

describe("discoverEndpoint", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "endpoint-discover-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (body: string) => {
    mkdirSync(join(root, ".deco", "tools"), { recursive: true });
    writeFileSync(join(root, ".deco", "tools", ".endpoint.json"), body);
  };

  test("finds the endpoint file walking up from a nested dir", () => {
    write(
      JSON.stringify({
        url: "http://x/mcp/virtual-mcp/a",
        headers: { Authorization: "Bearer k" },
        expiresAt: 99,
      }),
    );
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });

    expect(discoverEndpoint(nested)).toEqual({
      url: "http://x/mcp/virtual-mcp/a",
      headers: { Authorization: "Bearer k" },
      expiresAt: 99,
    });
  });

  test("returns null when no file exists up to the fs root", () => {
    expect(discoverEndpoint(root)).toBeNull();
  });

  test("returns null on malformed JSON or a missing url", () => {
    write("not json");
    expect(discoverEndpoint(root)).toBeNull();

    write(JSON.stringify({ headers: {} }));
    expect(discoverEndpoint(root)).toBeNull();
  });
});

describe("withMcpId / mcpIdFromUrl", () => {
  test("retargets the id, preserving base and path prefix", () => {
    expect(withMcpId("http://h:1/prefix/mcp/virtual-mcp/old", "new")).toBe(
      "http://h:1/prefix/mcp/virtual-mcp/new",
    );
  });

  test("encodes special characters in the new id", () => {
    expect(withMcpId("http://h/mcp/virtual-mcp/a", "x/y")).toBe(
      "http://h/mcp/virtual-mcp/x%2Fy",
    );
  });

  test("leaves a URL without the shape unchanged", () => {
    expect(withMcpId("http://h/custom", "new")).toBe("http://h/custom");
  });

  test("extracts the id, or undefined when absent", () => {
    expect(mcpIdFromUrl("http://h/mcp/virtual-mcp/x%2Fy")).toBe("x/y");
    expect(mcpIdFromUrl("http://h/custom")).toBeUndefined();
  });
});
