/**
 * Tests for Decopilot Helper Functions
 */

import { describe, expect, test } from "bun:test";
import { toolNeedsApproval, type ToolApprovalLevel } from "./helpers";

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

  describe('approval level: "plan"', () => {
    const level: ToolApprovalLevel = "plan";

    test("returns false when readOnlyHint is true (read-only allowed)", () => {
      expect(toolNeedsApproval(level, true)).toBe(false);
    });

    test('returns "hard-block" when readOnlyHint is false', () => {
      expect(toolNeedsApproval(level, false)).toBe("hard-block");
    });

    test('returns "hard-block" when readOnlyHint is undefined', () => {
      expect(toolNeedsApproval(level, undefined)).toBe("hard-block");
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
