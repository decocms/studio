import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type Domain,
  type EventBus,
  inMemoryBus,
  InMemoryGoalLedger,
  wire,
} from "./index";
import { ruleDeliberator } from "../deliberators/rule";

// A small storefront-like world: three metrics that improve as actions land,
// so the agent provably converges to the fixed target under the rule planner.
interface Shop {
  conversion: number;
  aov: number;
  bounce: number;
}
interface ShopTarget {
  conversion: number;
  aov: number;
  maxBounce: number;
}
interface ShopGap {
  conversion: number;
  aov: number;
  bounce: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function shopFixture() {
  const db = new Map<string, Shop>();
  const domain: Domain<Shop, ShopTarget, ShopGap> = {
    name: "shop",
    observe: async (tenant) =>
      structuredClone(db.get(tenant) ?? { conversion: 0, aov: 0, bounce: 1 }),
    satisfied: (s, t) =>
      s.conversion >= t.conversion && s.aov >= t.aov && s.bounce <= t.maxBounce,
    gap: (s, t) => ({
      conversion: round(t.conversion - s.conversion),
      aov: round(t.aov - s.aov),
      bounce: round(s.bounce - t.maxBounce),
    }),
    instructions: "close the gap to the fixed target",
    actions: [
      {
        kind: "lift_conversion",
        description: "raise conversion",
        schema: z.object({}),
        apply: async (tenant) => {
          const s = db.get(tenant)!;
          s.conversion = round(s.conversion + 0.01);
        },
      },
      {
        kind: "raise_aov",
        description: "raise average order value",
        schema: z.object({}),
        apply: async (tenant) => {
          const s = db.get(tenant)!;
          s.aov = round(s.aov + 8);
        },
      },
      {
        kind: "cut_bounce",
        description: "reduce bounce",
        schema: z.object({}),
        apply: async (tenant) => {
          const s = db.get(tenant)!;
          s.bounce = round(Math.max(0, s.bounce - 0.06));
        },
      },
    ],
    prompt: () => "close the gap",
    plan: ({ gap }) => {
      const steps: Array<{ kind: string; input: unknown }> = [];
      if (gap.conversion > 0)
        steps.push({ kind: "lift_conversion", input: {} });
      if (gap.aov > 0) steps.push({ kind: "raise_aov", input: {} });
      if (gap.bounce > 0) steps.push({ kind: "cut_bounce", input: {} });
      return steps;
    },
  };
  return { db, domain };
}

async function pumpUntilReached<T>(
  bus: EventBus<T>,
  tenant: string,
  cap = 50,
): Promise<boolean> {
  let reached = false;
  bus.subscribe("unmovedMover.reached", async (e) => {
    if (e.tenant === tenant) reached = true;
  });
  for (let i = 0; i < cap && !reached; i++) {
    await bus.publish({ type: "state.changed", tenant });
  }
  return reached;
}

describe("convergence (rule deliberator)", () => {
  test("a domain converges to its fixed star, then re-pursues a raised goal", async () => {
    const { db, domain } = shopFixture();
    const bus = inMemoryBus<ShopTarget>();
    const ledger = new InMemoryGoalLedger<ShopTarget>();
    db.set("acme", { conversion: 0.02, aov: 55, bounce: 0.6 });
    wire({ bus, ledger, domain, deliberator: ruleDeliberator });

    ledger.install("acme", { conversion: 0.045, aov: 80, maxBounce: 0.35 });
    expect(await pumpUntilReached(bus, "acme")).toBe(true);

    const afterV1 = db.get("acme")!;
    expect(afterV1.conversion).toBeGreaterThanOrEqual(0.045);
    expect(afterV1.aov).toBeGreaterThanOrEqual(80);
    expect(afterV1.bounce).toBeLessThanOrEqual(0.35);

    // raise the goal from above (v2); the gap reopens and the agent re-pursues
    await bus.publish({
      type: "goal.updated",
      tenant: "acme",
      target: { conversion: 0.06, aov: 95, maxBounce: 0.3 },
    });
    expect(ledger.latest("acme").version).toBe(2);
    expect(await pumpUntilReached(bus, "acme")).toBe(true);

    const afterV2 = db.get("acme")!;
    expect(afterV2.conversion).toBeGreaterThanOrEqual(0.06);
    expect(afterV2.aov).toBeGreaterThanOrEqual(95);
    expect(afterV2.bounce).toBeLessThanOrEqual(0.3);

    expect(ledger.history("acme").map((m) => m.version)).toEqual([1, 2]);
  });
});
