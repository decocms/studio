import { describe, expect, test } from "bun:test";
import { getRoleColor, getRoleDotColor } from "./role-color";

const DESIGN_SYSTEM_TOKEN_CLASSES = new Set([
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
  "bg-destructive",
  "bg-success",
  "bg-muted-foreground",
]);

describe("role-color", () => {
  test("builtin roles resolve to existing design-system token classes", () => {
    expect(
      DESIGN_SYSTEM_TOKEN_CLASSES.has(getRoleDotColor("owner", true)),
    ).toBe(true);
    expect(
      DESIGN_SYSTEM_TOKEN_CLASSES.has(getRoleDotColor("admin", true)),
    ).toBe(true);
    expect(DESIGN_SYSTEM_TOKEN_CLASSES.has(getRoleDotColor("user", true))).toBe(
      true,
    );
  });

  test("custom roles hash to a rotating design-system token class", () => {
    expect(DESIGN_SYSTEM_TOKEN_CLASSES.has(getRoleColor("editor"))).toBe(true);
    expect(DESIGN_SYSTEM_TOKEN_CLASSES.has(getRoleColor("viewer"))).toBe(true);
  });

  test("empty role name falls back to neutral", () => {
    expect(getRoleColor("")).toBe("bg-muted-foreground");
  });
});
