import { describe, expect, test } from "bun:test";
import { isObservable } from "./is-observable";

const allGuard = {
  observerAgentId: "vir_obs",
  scopeMode: "all" as const,
  scopeAgentIds: ["vir_excl1", "vir_excl2"],
};
const onlyGuard = {
  observerAgentId: "vir_obs",
  scopeMode: "only" as const,
  scopeAgentIds: ["vir_a"],
};

describe("isObservable", () => {
  test("the observer's own thread is never observable (loop prevention)", () => {
    expect(isObservable({ virtual_mcp_id: "vir_obs" }, allGuard)).toBe(false);
    // ...even if it somehow appears in an 'only' allowlist.
    expect(
      isObservable(
        { virtual_mcp_id: "vir_obs" },
        { ...onlyGuard, scopeAgentIds: ["vir_obs"] },
      ),
    ).toBe(false);
  });

  test("an empty agent id is not observable", () => {
    expect(isObservable({ virtual_mcp_id: "" }, allGuard)).toBe(false);
  });

  describe("scopeMode 'all' — observe everything except the list", () => {
    test("a normal agent is observable", () => {
      expect(isObservable({ virtual_mcp_id: "vir_a" }, allGuard)).toBe(true);
    });
    test("excluded agents are not observable", () => {
      expect(isObservable({ virtual_mcp_id: "vir_excl1" }, allGuard)).toBe(
        false,
      );
      expect(isObservable({ virtual_mcp_id: "vir_excl2" }, allGuard)).toBe(
        false,
      );
    });
    test("with an empty exclude list, everything is observable", () => {
      expect(
        isObservable(
          { virtual_mcp_id: "vir_a" },
          { ...allGuard, scopeAgentIds: [] },
        ),
      ).toBe(true);
    });
  });

  describe("scopeMode 'only' — observe just the allowlist", () => {
    test("an allowlisted agent is observable", () => {
      expect(isObservable({ virtual_mcp_id: "vir_a" }, onlyGuard)).toBe(true);
    });
    test("a non-allowlisted agent is not observable", () => {
      expect(isObservable({ virtual_mcp_id: "vir_b" }, onlyGuard)).toBe(false);
    });
    test("an empty allowlist observes nothing", () => {
      expect(
        isObservable(
          { virtual_mcp_id: "vir_a" },
          { ...onlyGuard, scopeAgentIds: [] },
        ),
      ).toBe(false);
    });
  });
});
