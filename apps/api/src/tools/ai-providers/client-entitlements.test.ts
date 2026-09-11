import { describe, expect, it } from "bun:test";
import { toClientEntitlements } from "./client-entitlements";
import type { PlanEntitlements } from "../../ai-providers/types";

const FULL: PlanEntitlements = {
  plan: { id: "pro", name: "Pro" },
  features: { chat: true, model_choice: false },
  usage: {
    percent: 0.5,
    state: "ok",
    usedMicros: 10_000_000,
    limitMicros: 20_000_000,
  },
  credits: { remainingUsd: 12.5 },
  modelPins: { fast: "z-ai/glm-4.6", smart: "z-ai/glm-4.6" },
  tasks: { allowed: true, remaining: 3, denyReason: null },
  periodStart: "2026-09-01T00:00:00.000Z",
  periodEnd: "2026-10-01T00:00:00.000Z",
};

describe("toClientEntitlements", () => {
  it("never hands the org a model name", () => {
    // §6: below Ultra the org is not told which model ran its work. The pin
    // reaching the browser through this payload would defeat the whole gate.
    const out = toClientEntitlements(FULL);
    expect("modelPins" in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain("glm");
  });

  it("is an allowlist, so a new server-only field cannot leak by default", () => {
    const withSecret = {
      ...FULL,
      somethingAddedLater: "internal",
    } as PlanEntitlements;
    expect(JSON.stringify(toClientEntitlements(withSecret))).not.toContain(
      "internal",
    );
  });

  it("keeps everything the card actually renders", () => {
    const out = toClientEntitlements(FULL);
    expect(out.plan.name).toBe("Pro");
    expect(out.usage?.percent).toBe(0.5);
    expect(out.credits?.remainingUsd).toBe(12.5);
    expect(out.tasks.remaining).toBe(3);
    expect(out.periodEnd).toBe("2026-10-01T00:00:00.000Z");
  });
});
