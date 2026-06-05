import { describe, expect, test } from "bun:test";
import { isObservable } from "./is-observable";

const guard = {
  observerAgentId: "vir_obs",
  skipAgentIds: ["vir_skip1", "vir_skip2"],
};

describe("isObservable", () => {
  test("a normal agent thread is observable", () => {
    expect(isObservable({ virtual_mcp_id: "vir_a" }, guard)).toBe(true);
  });

  test("the observer's own thread is never observable (loop prevention)", () => {
    expect(isObservable({ virtual_mcp_id: "vir_obs" }, guard)).toBe(false);
  });

  test("skip-listed agents are not observable", () => {
    expect(isObservable({ virtual_mcp_id: "vir_skip1" }, guard)).toBe(false);
    expect(isObservable({ virtual_mcp_id: "vir_skip2" }, guard)).toBe(false);
  });

  test("an empty agent id is not observable", () => {
    expect(isObservable({ virtual_mcp_id: "" }, guard)).toBe(false);
  });

  test("with an empty skip list, normal agents are still observable", () => {
    expect(
      isObservable(
        { virtual_mcp_id: "vir_a" },
        { observerAgentId: "vir_obs", skipAgentIds: [] },
      ),
    ).toBe(true);
  });
});
