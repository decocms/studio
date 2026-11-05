import { describe, expect, it } from "bun:test";
import {
  countTools,
  expiresInSeconds,
  keyPermissions,
  readOnlyToolNames,
  summarizeKeyAccess,
} from "./api-key-access";

const tool = (name: string, readOnlyHint?: boolean) => ({
  name,
  inputSchema: { type: "object" as const },
  ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
});

describe("readOnlyToolNames", () => {
  it("keeps only tools that declare readOnlyHint: true", () => {
    expect(
      readOnlyToolNames([
        tool("ORGANIZATION_GET", true),
        tool("ORGANIZATION_DELETE", false),
        tool("REGISTRY_ITEM_LIST"),
      ]),
    ).toEqual(["ORGANIZATION_GET"]);
  });

  it("returns nothing for an empty tool list", () => {
    expect(readOnlyToolNames([])).toEqual([]);
  });
});

describe("keyPermissions", () => {
  it("grants every tool only for full access", () => {
    expect(keyPermissions("full", ["A"], { self: ["B"] })).toEqual({
      "*": ["*"],
    });
  });

  it("lists the read-only Studio tools by name", () => {
    expect(keyPermissions("read-only", ["A", "B"], { conn_a: ["C"] })).toEqual({
      self: ["A", "B"],
    });
  });

  it("keeps each custom resource and drops the empty ones", () => {
    expect(
      keyPermissions("custom", ["A"], {
        self: ["B"],
        conn_a: ["SEND_MESSAGE"],
        conn_b: [],
      }),
    ).toEqual({ self: ["B"], conn_a: ["SEND_MESSAGE"] });
  });

  it("grants nothing for an empty custom selection", () => {
    expect(keyPermissions("custom", ["A"], {})).toEqual({});
  });
});

describe("countTools", () => {
  it("adds up tools across resources", () => {
    expect(countTools({ self: ["A", "B"], conn_a: ["C"] })).toBe(3);
    expect(countTools({})).toBe(0);
  });
});

describe("expiresInSeconds", () => {
  it("converts days to seconds", () => {
    expect(expiresInSeconds("30")).toBe(30 * 86_400);
  });

  it("omits the expiry for keys that never expire", () => {
    expect(expiresInSeconds("never")).toBeUndefined();
  });
});

describe("summarizeKeyAccess", () => {
  it("reads org-wide and self wildcards as full access", () => {
    expect(summarizeKeyAccess({ "*": ["*"] })).toEqual({ kind: "full" });
    expect(summarizeKeyAccess({ self: ["*"] })).toEqual({ kind: "full" });
  });

  it("does not read a single connection's wildcard as full access", () => {
    expect(summarizeKeyAccess({ conn_a: ["*"] })).toEqual({
      kind: "tools",
      count: 1,
    });
  });

  it("counts granted tools, ignoring denials and duplicates", () => {
    expect(
      summarizeKeyAccess({
        self: ["ORGANIZATION_GET", "ORGANIZATION_GET", "!API_KEY_CREATE"],
        conn_a: ["SEND_MESSAGE"],
      }),
    ).toEqual({ kind: "tools", count: 2 });
  });

  it("tolerates an empty or malformed stored map", () => {
    expect(summarizeKeyAccess({})).toEqual({ kind: "tools", count: 0 });
    expect(
      summarizeKeyAccess({ self: "ORGANIZATION_GET" } as unknown as Record<
        string,
        string[]
      >),
    ).toEqual({ kind: "tools", count: 0 });
  });
});
