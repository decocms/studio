import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type Domain, Eudaimon } from "./core";
import { inMemoryBus } from "./bus";
import { InMemoryGoalLedger } from "./ledger";
import { ruleDeliberator } from "./deliberate-rule";
import { type Daimonion, guardedBy } from "./daimonion";

interface CounterState {
  value: number;
}
interface CounterTarget {
  goal: number;
}

function fixture() {
  const db = new Map<string, CounterState>();
  const domain: Domain<CounterState, CounterTarget, number> = {
    name: "counter",
    observe: async (t) => ({ value: db.get(t)?.value ?? 0 }),
    satisfied: (s, t) => s.value >= t.goal,
    gap: (s, t) => t.goal - s.value,
    instructions: "increment toward the goal",
    actions: [
      {
        kind: "increment",
        description: "increment by one",
        schema: z.object({}),
        apply: async (t) => {
          const c = db.get(t) ?? { value: 0 };
          db.set(t, { value: c.value + 1 });
        },
      },
    ],
    prompt: () => "increment",
    plan: ({ gap }) => (gap > 0 ? [{ kind: "increment", input: {} }] : []),
  };
  return { db, domain };
}

describe("daimonion — apophatic guardrail", () => {
  test("a vetoed action never applies and emits eudaimon.action.vetoed", async () => {
    const { db, domain } = fixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 3 });
    db.set("t", { value: 0 });

    const applied: string[] = [];
    const vetoed: string[] = [];
    bus.subscribe("eudaimon.action.applied", async (e) => {
      applied.push(e.kind);
    });
    bus.subscribe("eudaimon.action.vetoed", async (e) => {
      vetoed.push(`${e.kind}:${e.reason}`);
    });

    const daimonion: Daimonion = {
      veto: async ({ kind }) =>
        kind === "increment" ? { reason: "forbidden" } : null,
    };

    const agent = new Eudaimon({
      tenant: "t",
      ledger,
      domain: guardedBy(daimonion)(domain),
      bus,
      deliberator: ruleDeliberator,
    });
    await agent.pursue();

    expect(db.get("t")?.value).toBe(0); // side effect blocked
    expect(applied).toEqual([]); // not recorded as applied
    expect(vetoed).toEqual(["increment:forbidden"]);
  });

  test("a silent daimonion (null) allows the action through", async () => {
    const { db, domain } = fixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 3 });
    db.set("t", { value: 0 });

    const daimonion: Daimonion = { veto: async () => null };
    const agent = new Eudaimon({
      tenant: "t",
      ledger,
      domain: guardedBy(daimonion)(domain),
      bus,
      deliberator: ruleDeliberator,
    });
    await agent.pursue();

    expect(db.get("t")?.value).toBe(1);
  });

  test("the daimonion screens per-action, not all-or-nothing", async () => {
    const db = new Map<string, CounterState>();
    const domain: Domain<CounterState, CounterTarget, number> = {
      name: "two-action",
      observe: async (t) => ({ value: db.get(t)?.value ?? 0 }),
      satisfied: (s, t) => s.value >= t.goal,
      gap: (s, t) => t.goal - s.value,
      instructions: "grow",
      actions: [
        {
          kind: "safe_step",
          description: "ok",
          schema: z.object({}),
          apply: async (t) => {
            const c = db.get(t) ?? { value: 0 };
            db.set(t, { value: c.value + 1 });
          },
        },
        {
          kind: "risky_step",
          description: "danger",
          schema: z.object({}),
          apply: async (t) => {
            const c = db.get(t) ?? { value: 0 };
            db.set(t, { value: c.value + 100 });
          },
        },
      ],
      prompt: () => "grow",
      plan: () => [
        { kind: "safe_step", input: {} },
        { kind: "risky_step", input: {} },
      ],
    };
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 999 });
    db.set("t", { value: 0 });

    const daimonion: Daimonion = {
      veto: async ({ kind }) =>
        kind === "risky_step" ? { reason: "too risky" } : null,
    };
    const agent = new Eudaimon({
      tenant: "t",
      ledger,
      domain: guardedBy(daimonion)(domain),
      bus,
      deliberator: ruleDeliberator,
    });
    await agent.pursue();

    expect(db.get("t")?.value).toBe(1); // safe applied (+1), risky vetoed (+100 blocked)
  });
});
