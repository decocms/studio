import { describe, expect, test } from "bun:test";
import { automationMatchesRouteAgent } from "./automation-route";

describe("automationMatchesRouteAgent", () => {
  test("accepts the route that owns the automation", () => {
    expect(automationMatchesRouteAgent("agent-a", "agent-a")).toBe(true);
  });

  test("rejects a cross-agent automation route", () => {
    expect(automationMatchesRouteAgent("agent-b", "agent-a")).toBe(false);
  });
});
