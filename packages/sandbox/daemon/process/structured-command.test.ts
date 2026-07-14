import { describe, expect, test } from "bun:test";
import { delimiter } from "node:path";
import {
  formatCommand,
  isStructuredCommand,
  withPathDirs,
} from "./structured-command";

describe("isStructuredCommand", () => {
  test("discriminates strings from structured commands", () => {
    expect(isStructuredCommand("git clone x")).toBe(false);
    expect(isStructuredCommand({ argv: ["git", "clone"] })).toBe(true);
    expect(isStructuredCommand({ argv: [] })).toBe(false); // empty argv invalid
    expect(isStructuredCommand(null)).toBe(false);
  });
});

describe("withPathDirs", () => {
  test("prepends dirs to PATH with the platform delimiter", () => {
    const env = withPathDirs(["/opt/bun/bin"], { PATH: "/usr/bin" });
    expect(env.PATH).toBe(`/opt/bun/bin${delimiter}/usr/bin`);
  });

  test("no dirs returns empty object (no PATH override)", () => {
    expect(withPathDirs([], { PATH: "/usr/bin" })).toEqual({});
  });

  test("missing base PATH still yields the dirs", () => {
    const env = withPathDirs(["/opt/deno/bin"], {});
    expect(env.PATH).toBe("/opt/deno/bin");
  });
});

describe("formatCommand", () => {
  test("string passes through; argv joins with quoting for spaced args", () => {
    expect(formatCommand("bun install")).toBe("bun install");
    expect(
      formatCommand({ argv: ["git", "clone", "https://x", "C:\\My Dir"] }),
    ).toBe('git clone https://x "C:\\My Dir"');
  });
});
