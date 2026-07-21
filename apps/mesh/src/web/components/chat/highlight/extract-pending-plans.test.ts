import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../types.ts";
import {
  extractPendingPlans,
  selectActivePlan,
  type PendingPlan,
} from "./extract-pending-plans";

describe("extractPendingPlans", () => {
  test("no propose_plan part → []", () => {
    const parts = [
      { type: "text", text: "hi" },
    ] as unknown as ChatMessage["parts"];
    expect(extractPendingPlans(parts)).toEqual([]);
  });

  test("input-available propose_plan part → extracted", () => {
    const parts = [
      {
        type: "tool-propose_plan",
        toolCallId: "c1",
        state: "input-available",
        input: { plan: "Do the thing" },
      },
    ] as unknown as ChatMessage["parts"];
    expect(extractPendingPlans(parts)).toEqual([
      { toolCallId: "c1", plan: "Do the thing", state: "input-available" },
    ]);
  });

  test("non-input-available state is ignored", () => {
    const parts = [
      {
        type: "tool-propose_plan",
        toolCallId: "c1",
        state: "output-available",
        input: { plan: "Do the thing" },
      },
    ] as unknown as ChatMessage["parts"];
    expect(extractPendingPlans(parts)).toEqual([]);
  });
});

describe("selectActivePlan", () => {
  test("empty list → undefined", () => {
    expect(selectActivePlan([])).toBeUndefined();
  });

  test("multiple pending plans → the most recent one", () => {
    const plans: PendingPlan[] = [
      { toolCallId: "c1", plan: "First plan", state: "input-available" },
      { toolCallId: "c2", plan: "Second plan", state: "input-available" },
    ];
    expect(selectActivePlan(plans)).toEqual(plans[1]);
  });
});
