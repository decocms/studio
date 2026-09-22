import { describe, expect, it } from "bun:test";
import {
  PLAN_REFUSAL_CODES,
  planRefusalOf,
  StudioToolError,
} from "./studio-tools";

describe("planRefusalOf", () => {
  it("recognises both codes the server actually sends", () => {
    for (const code of Object.values(PLAN_REFUSAL_CODES)) {
      expect(planRefusalOf(new StudioToolError("nope", 403, code))).toBe(code);
    }
  });

  it("is null for a tool error carrying no code — the old shape", () => {
    expect(planRefusalOf(new StudioToolError("boom", 500))).toBeNull();
  });

  it("is null for some other code, so an unrelated 403 is not a paywall", () => {
    expect(
      planRefusalOf(new StudioToolError("nope", 403, "forbidden")),
    ).toBeNull();
  });

  it("is null for anything that is not a StudioToolError", () => {
    for (const other of [
      null,
      undefined,
      "feature_not_in_plan",
      new Error("x"),
    ]) {
      expect(planRefusalOf(other)).toBeNull();
    }
  });
});
