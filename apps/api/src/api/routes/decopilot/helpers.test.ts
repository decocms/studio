/**
 * Tests for Decopilot Helper Functions
 */

import { describe, expect, test } from "bun:test";
import {
  buildSanitizedNameMap,
  sanitizeToolName,
  toolNeedsApproval,
  type ToolApprovalLevel,
} from "./helpers";

// Gemini's naming rules for reference:
// - Must start with a letter or underscore
// - Only [a-zA-Z0-9_.\-:] allowed
// - Max 128 characters
const GEMINI_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.\-:]*$/;

function isGeminiValid(name: string): boolean {
  return GEMINI_NAME_RE.test(name) && name.length <= 128;
}

describe("sanitizeToolName", () => {
  // ── Valid names (no-op) ──────────────────────────────────────────────
  test("leaves uppercase snake_case unchanged", () => {
    expect(sanitizeToolName("SEARCH")).toBe("SEARCH");
    expect(sanitizeToolName("COLLECTION_CONNECTIONS_CREATE")).toBe(
      "COLLECTION_CONNECTIONS_CREATE",
    );
  });

  test("leaves lowercase snake_case unchanged", () => {
    expect(sanitizeToolName("my_tool")).toBe("my_tool");
    expect(sanitizeToolName("user_ask")).toBe("user_ask");
  });

  test("leaves kebab-case unchanged", () => {
    expect(sanitizeToolName("conn-abc")).toBe("conn-abc");
    expect(sanitizeToolName("my-server-tool")).toBe("my-server-tool");
  });

  test("leaves namespaced names unchanged", () => {
    expect(sanitizeToolName("conn-abc_SEARCH")).toBe("conn-abc_SEARCH");
    expect(sanitizeToolName("server-1_my_tool")).toBe("server-1_my_tool");
  });

  test("leaves dots unchanged", () => {
    expect(sanitizeToolName("tool.v2")).toBe("tool.v2");
    expect(sanitizeToolName("api.v1.search")).toBe("api.v1.search");
  });

  test("leaves colons unchanged", () => {
    expect(sanitizeToolName("ns:action")).toBe("ns:action");
    expect(sanitizeToolName("mcp:tool:run")).toBe("mcp:tool:run");
  });

  test("leaves underscore-prefixed names unchanged", () => {
    expect(sanitizeToolName("_private")).toBe("_private");
    expect(sanitizeToolName("__internal")).toBe("__internal");
  });

  // ── Invalid character replacement ────────────────────────────────────
  test("replaces spaces with underscores", () => {
    expect(sanitizeToolName("my tool")).toBe("my_tool");
    expect(sanitizeToolName("create new item")).toBe("create_new_item");
  });

  test("replaces slashes with underscores", () => {
    expect(sanitizeToolName("tool/action")).toBe("tool_action");
    expect(sanitizeToolName("a/b/c")).toBe("a_b_c");
  });

  test("replaces mixed special characters", () => {
    expect(sanitizeToolName("tool@name#1")).toBe("tool_name_1");
    expect(sanitizeToolName("run(test)")).toBe("run_test_");
    expect(sanitizeToolName("a+b=c")).toBe("a_b_c");
  });

  test("replaces unicode characters", () => {
    expect(sanitizeToolName("tøol")).toBe("t_ol");
    expect(sanitizeToolName("工具")).toBe("__");
  });

  test("replaces backslashes and quotes", () => {
    expect(sanitizeToolName('tool\\"name')).toBe("tool__name");
    expect(sanitizeToolName("tool\\path")).toBe("tool_path");
  });

  test("replaces consecutive special chars with individual underscores", () => {
    expect(sanitizeToolName("a  b")).toBe("a__b");
    expect(sanitizeToolName("a//b")).toBe("a__b");
  });

  // ── Leading character enforcement ────────────────────────────────────
  test("prepends underscore when name starts with digit", () => {
    expect(sanitizeToolName("123tool")).toBe("_123tool");
    expect(sanitizeToolName("0_start")).toBe("_0_start");
    expect(sanitizeToolName("9")).toBe("_9");
  });

  test("prepends underscore when name starts with dot", () => {
    expect(sanitizeToolName(".hidden")).toBe("_.hidden");
  });

  test("prepends underscore when name starts with colon", () => {
    expect(sanitizeToolName(":action")).toBe("_:action");
  });

  test("prepends underscore when name starts with dash", () => {
    expect(sanitizeToolName("-flag")).toBe("_-flag");
  });

  // ── Edge cases ───────────────────────────────────────────────────────
  test("handles empty string", () => {
    expect(sanitizeToolName("")).toBe("_");
  });

  test("handles all-invalid characters", () => {
    expect(sanitizeToolName("!!!")).toBe("___");
    expect(sanitizeToolName("@#$")).toBe("___");
  });

  test("handles single valid character", () => {
    expect(sanitizeToolName("a")).toBe("a");
    expect(sanitizeToolName("Z")).toBe("Z");
    expect(sanitizeToolName("_")).toBe("_");
  });

  test("handles single invalid character", () => {
    // " " → "_" (replacement), starts with "_" so no prefix needed
    expect(sanitizeToolName(" ")).toBe("_");
    expect(sanitizeToolName("/")).toBe("_");
    // "." → "." starts with dot, not letter/underscore → prefix → "_."
    expect(sanitizeToolName(".")).toBe("_.");
  });

  // ── Truncation ───────────────────────────────────────────────────────
  test("truncates to 128 characters", () => {
    const longName = "a".repeat(200);
    const result = sanitizeToolName(longName);
    expect(result.length).toBe(128);
    expect(result).toBe("a".repeat(128));
  });

  test("truncates after prepending underscore", () => {
    // 200 digits → "_" prefix + 200 digits → truncated to 128
    const longDigits = "1".repeat(200);
    const result = sanitizeToolName(longDigits);
    expect(result.length).toBe(128);
    expect(result[0]).toBe("_");
  });

  test("does not truncate at exactly 128 characters", () => {
    const exact = "a".repeat(128);
    expect(sanitizeToolName(exact)).toBe(exact);
  });

  // ── Output always valid ──────────────────────────────────────────────
  test("output always matches Gemini naming rules", () => {
    const edgeCases = [
      "",
      " ",
      "0",
      "123",
      "!!!",
      "a".repeat(200),
      "1".repeat(200),
      "my tool/action@v2#test",
      "conn-abc_SEARCH",
      "COLLECTION_CREATE",
      ".hidden",
      "-flag",
      ":ns",
      "工具名",
      "a b c d e",
      "a/b/c/d/e",
    ];
    for (const input of edgeCases) {
      const result = sanitizeToolName(input);
      expect(isGeminiValid(result)).toBe(true);
    }
  });
});

describe("buildSanitizedNameMap", () => {
  // ── Basic mapping ────────────────────────────────────────────────────
  test("maps already-valid names unchanged", () => {
    const map = buildSanitizedNameMap(["foo", "bar", "baz"]);
    expect(map.get("foo")).toBe("foo");
    expect(map.get("bar")).toBe("bar");
    expect(map.get("baz")).toBe("baz");
  });

  test("sanitizes invalid names", () => {
    const map = buildSanitizedNameMap(["my tool", "123start"]);
    expect(map.get("my tool")).toBe("my_tool");
    expect(map.get("123start")).toBe("_123start");
  });

  test("maps single name", () => {
    const map = buildSanitizedNameMap(["only"]);
    expect(map.get("only")).toBe("only");
  });

  test("returns empty map for empty input", () => {
    const map = buildSanitizedNameMap([]);
    expect(map.size).toBe(0);
  });

  // ── Collision handling ───────────────────────────────────────────────
  test("handles two-way collision", () => {
    // "my tool" and "my/tool" both sanitize to "my_tool"
    const map = buildSanitizedNameMap(["my tool", "my/tool"]);
    expect(map.get("my tool")).toBe("my_tool");
    expect(map.get("my/tool")).toBe("my_tool_2");
  });

  test("handles three-way collision", () => {
    const map = buildSanitizedNameMap(["my tool", "my/tool", "my+tool"]);
    expect(map.get("my tool")).toBe("my_tool");
    expect(map.get("my/tool")).toBe("my_tool_2");
    expect(map.get("my+tool")).toBe("my_tool_3");
  });

  test("first occurrence wins the unsuffixed name", () => {
    const map = buildSanitizedNameMap(["a/b", "a b", "a+b"]);
    expect(map.get("a/b")).toBe("a_b");
    expect(map.get("a b")).toBe("a_b_2");
    expect(map.get("a+b")).toBe("a_b_3");
  });

  test("no collision between unrelated names", () => {
    const map = buildSanitizedNameMap(["alpha", "beta", "gamma"]);
    expect(map.get("alpha")).toBe("alpha");
    expect(map.get("beta")).toBe("beta");
    expect(map.get("gamma")).toBe("gamma");
  });

  test("collision where one name already has the suffix pattern", () => {
    // "a_b" is valid, "a/b" sanitizes to "a_b" → collision → "a_b_2"
    // "a_b_2" is a real tool name → no collision because it's already registered
    const map = buildSanitizedNameMap(["a_b", "a_b_2", "a/b"]);
    expect(map.get("a_b")).toBe("a_b");
    expect(map.get("a_b_2")).toBe("a_b_2");
    // "a/b" → "a_b" taken, "a_b_2" taken, so gets "a_b_3"
    expect(map.get("a/b")).toBe("a_b_3");
  });

  // ── Collision + truncation ───────────────────────────────────────────
  test("collision suffix stays within 128-char limit", () => {
    const longName = "a".repeat(200);
    const map = buildSanitizedNameMap([longName, longName + "x"]);
    for (const safeName of map.values()) {
      expect(safeName.length).toBeLessThanOrEqual(128);
      expect(isGeminiValid(safeName)).toBe(true);
    }
  });

  test("collision with exactly 128-char base truncates base for suffix", () => {
    const base128 = "a".repeat(128);
    const map = buildSanitizedNameMap([base128, base128 + "b"]);
    // First gets "a"*128 (truncated from 200? no, base128 is exactly 128)
    expect(map.get(base128)!.length).toBe(128);
    // Second collides → base trimmed to 124 + "_2" = 126
    const second = map.get(base128 + "b")!;
    expect(second.length).toBeLessThanOrEqual(128);
    expect(second).toBe("a".repeat(124) + "_2");
    expect(isGeminiValid(second)).toBe(true);
  });

  test("many collisions with long names all stay valid", () => {
    const names = Array.from(
      { length: 15 },
      (_, i) => "x".repeat(130) + String.fromCharCode(65 + i),
    );
    const map = buildSanitizedNameMap(names);
    const seen = new Set<string>();
    for (const safeName of map.values()) {
      expect(safeName.length).toBeLessThanOrEqual(128);
      expect(isGeminiValid(safeName)).toBe(true);
      expect(seen.has(safeName)).toBe(false);
      seen.add(safeName);
    }
  });

  // ── All outputs valid ────────────────────────────────────────────────
  test("all output names are unique", () => {
    const names = [
      "search",
      "SEARCH",
      "my tool",
      "my/tool",
      "my+tool",
      "123start",
      "",
      "a".repeat(200),
      "a".repeat(200) + "!",
    ];
    const map = buildSanitizedNameMap(names);
    const values = [...map.values()];
    expect(new Set(values).size).toBe(values.length);
  });

  test("all output names pass Gemini validation", () => {
    const names = [
      "valid_name",
      "has space",
      "has/slash",
      "123numeric",
      ".dotstart",
      "",
      "工具",
      "a".repeat(200),
    ];
    const map = buildSanitizedNameMap(names);
    for (const safeName of map.values()) {
      expect(isGeminiValid(safeName)).toBe(true);
    }
  });

  test("preserves original-to-safe mapping for all entries", () => {
    const names = ["a", "b", "c"];
    const map = buildSanitizedNameMap(names);
    expect(map.size).toBe(3);
    for (const name of names) {
      expect(map.has(name)).toBe(true);
    }
  });
});

describe("toolNeedsApproval", () => {
  describe('approval level: "auto"', () => {
    const level: ToolApprovalLevel = "auto";

    test("returns false when readOnlyHint is true", () => {
      expect(toolNeedsApproval(level, true)).toBe(false);
    });

    test("returns false when readOnlyHint is false", () => {
      expect(toolNeedsApproval(level, false)).toBe(false);
    });

    test("returns false when readOnlyHint is undefined", () => {
      expect(toolNeedsApproval(level, undefined)).toBe(false);
    });
  });

  describe("plan mode (isPlanMode)", () => {
    const level: ToolApprovalLevel = "auto";

    test("returns false when readOnlyHint is true (read-only allowed)", () => {
      expect(toolNeedsApproval(level, true, { isPlanMode: true })).toBe(false);
    });

    test('returns "hard-block" when readOnlyHint is false', () => {
      expect(toolNeedsApproval(level, false, { isPlanMode: true })).toBe(
        "hard-block",
      );
    });

    test('returns "hard-block" when readOnlyHint is undefined', () => {
      expect(toolNeedsApproval(level, undefined, { isPlanMode: true })).toBe(
        "hard-block",
      );
    });
  });

  describe('approval level: "readonly"', () => {
    const level: ToolApprovalLevel = "readonly";

    test("returns false when readOnlyHint is true (auto-approve)", () => {
      expect(toolNeedsApproval(level, true)).toBe(false);
    });

    test("returns true when readOnlyHint is false (requires approval)", () => {
      expect(toolNeedsApproval(level, false)).toBe(true);
    });

    test("returns true when readOnlyHint is undefined (requires approval)", () => {
      expect(toolNeedsApproval(level, undefined)).toBe(true);
    });
  });
});
