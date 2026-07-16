/**
 * buildBuiltInTools — plan-mode gating for propose_plan.
 */

import { describe, expect, test } from "bun:test";
import { buildBuiltInTools } from "./index";

const baseOpts = {
  ctx: {} as never,
  writer: {} as never,
  toolOutputMap: new Map<string, string>(),
  // provider: null skips subtask construction, so no ctx/writer plumbing is
  // exercised — this stays a pure unit test.
  subtaskParams: { provider: null } as never,
};

describe("buildBuiltInTools", () => {
  test("omits propose_plan outside plan mode", () => {
    const tools = buildBuiltInTools({ ...baseOpts, planMode: false });
    expect(tools.propose_plan).toBeUndefined();
  });

  test("includes propose_plan in plan mode", () => {
    const tools = buildBuiltInTools({ ...baseOpts, planMode: true });
    expect(tools.propose_plan).toBeDefined();
  });
});
