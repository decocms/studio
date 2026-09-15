import { describe, expect, it } from "bun:test";
import { chatPostErrorMessage, planRefusalKind } from "./chat-post-error";

describe("chatPostErrorMessage", () => {
  it("unwraps the route's JSON envelope", () => {
    expect(
      chatPostErrorMessage(
        '{"error":"No model available for tier \\"smart\\""}',
        400,
      ),
    ).toBe('No model available for tier "smart"');
  });

  it("marks the two plan refusals so the chat can render a plan card", () => {
    const budget = chatPostErrorMessage(
      '{"error":"Chat is paused","code":"ai_budget_exhausted"}',
      403,
    );
    expect(budget).toBe("[PLAN_BUDGET] Chat is paused");
    expect(planRefusalKind(new Error(budget))).toBe("ai_budget_exhausted");

    const feature = chatPostErrorMessage(
      '{"error":"No chat on this plan","code":"feature_not_in_plan"}',
      403,
    );
    expect(planRefusalKind(new Error(feature))).toBe("feature_not_in_plan");
  });

  it("leaves a non-envelope body alone, and names the status for an empty one", () => {
    expect(chatPostErrorMessage("<html>502</html>", 502)).toBe(
      "<html>502</html>",
    );
    expect(chatPostErrorMessage("{not json", 500)).toBe("{not json");
    expect(chatPostErrorMessage("{}", 500)).toBe("{}");
    expect(chatPostErrorMessage("", 504)).toBe("POST /messages failed (504)");
  });

  it("reports no refusal for an ordinary error", () => {
    expect(planRefusalKind(new Error("boom"))).toBeNull();
    expect(planRefusalKind(null)).toBeNull();
  });
});
