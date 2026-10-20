import { describe, expect, test } from "bun:test";
import { resolveToolByName, TOOL_BY_NAME } from "./index";

/**
 * The compatibility half of the Commerce Discovery → Reports rename. A tool
 * name is a wire identifier, so the old one has to keep resolving for a
 * release — while only the current one is advertised.
 */
describe("resolveToolByName", () => {
  const renamed = [
    ["COMMERCE_DISCOVERY_SETUP", "REPORTS_SETUP"],
    ["COMMERCE_DISCOVERY_RUN", "REPORTS_RUN"],
    ["COMMERCE_DISCOVERY_BIND", "REPORTS_BIND"],
    ["COMMERCE_DISCOVERY_CONNECTION_STATUS", "REPORTS_CONNECTION_STATUS"],
  ] as const;

  test("the current name resolves", () => {
    for (const [, current] of renamed) {
      expect(resolveToolByName(current)?.name).toBe(current);
    }
  });

  test("the name it shipped under resolves to the same tool", () => {
    for (const [legacy, current] of renamed) {
      expect(resolveToolByName(legacy)).toBe(resolveToolByName(current)!);
    }
  });

  test("a legacy name is never ADVERTISED — listings iterate TOOL_BY_NAME", () => {
    for (const [legacy] of renamed) {
      expect(TOOL_BY_NAME.has(legacy)).toBe(false);
    }
    const names = [...TOOL_BY_NAME.values()].map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("an unknown name resolves to nothing, rather than to a neighbour", () => {
    expect(resolveToolByName("COMMERCE_DISCOVERY_NOPE")).toBeUndefined();
    expect(resolveToolByName("")).toBeUndefined();
  });

  /** The tool that never shipped under the old name gets no alias. */
  test("REPORTS_SET_REPOSITORY has no legacy spelling", () => {
    expect(resolveToolByName("REPORTS_SET_REPOSITORY")).toBeDefined();
    expect(
      resolveToolByName("COMMERCE_DISCOVERY_SET_REPOSITORY"),
    ).toBeUndefined();
  });
});
