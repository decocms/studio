import { describe, expect, test } from "bun:test";
import { resolveTargetConfigId } from "./resolve-target-config-id";

describe("resolveTargetConfigId", () => {
  test("locked config always wins", () => {
    expect(resolveTargetConfigId([{ id: "a" }, { id: "b" }], "b", "a")).toBe(
      "b",
    );
  });

  test("single config is used regardless of last-selected", () => {
    expect(resolveTargetConfigId([{ id: "a" }], null, "other")).toBe("a");
  });

  test("no configs returns null", () => {
    expect(resolveTargetConfigId([], null, "a")).toBe(null);
  });

  test("multiple configs use last-selected if still present", () => {
    expect(resolveTargetConfigId([{ id: "a" }, { id: "b" }], null, "b")).toBe(
      "b",
    );
  });

  test("multiple configs with stale/missing last-selected returns null", () => {
    expect(
      resolveTargetConfigId([{ id: "a" }, { id: "b" }], null, "stale"),
    ).toBe(null);
    expect(resolveTargetConfigId([{ id: "a" }, { id: "b" }], null, null)).toBe(
      null,
    );
  });
});
