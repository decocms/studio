import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import {
  filterBuiltInsByAllowlist,
  filterPassthroughByAllowlist,
} from "./tool-allowlist";

/**
 * These filters sit on the path every agent in the platform runs through, so
 * the property that matters most is the one about doing nothing: a caller that
 * names no tools must get exactly the set it got before any of this existed.
 */

const set = (...names: string[]): ToolSet =>
  Object.fromEntries(names.map((name) => [name, {}])) as ToolSet;

describe("filterPassthroughByAllowlist", () => {
  const tools = set("safe_one", "safe_two");
  const nameMap = new Map([
    ["RAW_ONE", "safe_one"],
    ["RAW_TWO", "safe_two"],
  ]);

  test("leaves the set alone when nothing is named", () => {
    expect(filterPassthroughByAllowlist(tools, nameMap, null)).toBe(tools);
  });

  test("matches on the raw name the picker lists", () => {
    const kept = filterPassthroughByAllowlist(
      tools,
      nameMap,
      new Set(["RAW_ONE"]),
    );
    expect(Object.keys(kept)).toEqual(["safe_one"]);
  });

  test("matches on the model-facing name too", () => {
    const kept = filterPassthroughByAllowlist(
      tools,
      nameMap,
      new Set(["safe_two"]),
    );
    expect(Object.keys(kept)).toEqual(["safe_two"]);
  });

  test("matches the tool's own name under the gateway's prefix", () => {
    const namespaced = set("asfcidh_BLOG_STATE_GET");
    const kept = filterPassthroughByAllowlist(
      namespaced,
      new Map([["asfcidh_BLOG_STATE_GET", "asfcidh_BLOG_STATE_GET"]]),
      new Set(["BLOG_STATE_GET"]),
    );
    expect(Object.keys(kept)).toEqual(["asfcidh_BLOG_STATE_GET"]);
  });

  test("a first segment that is not a namespace code is part of the name", () => {
    const kept = filterPassthroughByAllowlist(
      set("VTEX_LIST_CATEGORIES"),
      new Map([["VTEX_LIST_CATEGORIES", "VTEX_LIST_CATEGORIES"]]),
      new Set(["LIST_CATEGORIES"]),
    );
    expect(Object.keys(kept)).toEqual([]);
  });

  test("a name nothing maps to keeps nothing", () => {
    const kept = filterPassthroughByAllowlist(
      tools,
      nameMap,
      new Set(["INVENTED"]),
    );
    expect(Object.keys(kept)).toEqual([]);
  });
});

describe("filterBuiltInsByAllowlist", () => {
  const tools = set("web_search", "generate_image", "read_tool_output");

  test("leaves the set alone when nothing is named", () => {
    expect(filterBuiltInsByAllowlist(tools, null)).toBe(tools);
  });

  test("keeps the loop's own mechanics whatever the list says", () => {
    const kept = filterBuiltInsByAllowlist(tools, new Set(["web_search"]));
    expect(Object.keys(kept).sort()).toEqual([
      "read_tool_output",
      "web_search",
    ]);
  });

  test("drops a capability the list does not name", () => {
    const kept = filterBuiltInsByAllowlist(tools, new Set(["web_search"]));
    expect(kept).not.toHaveProperty("generate_image");
  });
});
