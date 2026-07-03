import { describe, expect, it } from "bun:test";
import { stripMcpServerPrefix } from "./tool-namespace";

describe("stripMcpServerPrefix", () => {
  it("strips the mcp__<server>__ prefix added by coding agents", () => {
    expect(stripMcpServerPrefix("mcp__cms__conn-abc_hello_world")).toBe(
      "conn-abc_hello_world",
    );
  });

  it("strips a server name containing hyphens and digits", () => {
    expect(stripMcpServerPrefix("mcp__my-server-2__do_thing")).toBe("do_thing");
  });

  it("leaves names without the prefix untouched", () => {
    expect(stripMcpServerPrefix("conn-abc_hello_world")).toBe(
      "conn-abc_hello_world",
    );
  });

  it("leaves a name that merely contains 'mcp' untouched when it lacks the double-underscore shape", () => {
    expect(stripMcpServerPrefix("some_mcp_tool")).toBe("some_mcp_tool");
  });

  it("returns an empty string unchanged", () => {
    expect(stripMcpServerPrefix("")).toBe("");
  });
});
