import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type Deliberator,
  type Domain,
  type DomainEvent,
  Eudaimon,
  UnmovedMover,
  wire,
} from "./core";
import { inMemoryBus } from "./bus";
import { InMemoryGoalLedger } from "./ledger";
import { ruleDeliberator } from "./deliberate-rule";

// ── A tiny REAL domain (not a mock): a counter pursued toward a target. ───────
interface CounterState {
  value: number;
}
interface CounterTarget {
  goal: number;
}

function counterFixture() {
  const db = new Map<string, CounterState>();
  const domain: Domain<CounterState, CounterTarget, number> = {
    name: "counter",
    observe: async (tenant) => ({ value: db.get(tenant)?.value ?? 0 }),
    satisfied: (s, t) => s.value >= t.goal,
    gap: (s, t) => t.goal - s.value,
    instructions: "Increment toward the fixed goal.",
    actions: [
      {
        kind: "increment",
        description: "increment the counter by one",
        schema: z.object({}),
        apply: async (tenant) => {
          const cur = db.get(tenant) ?? { value: 0 };
          db.set(tenant, { value: cur.value + 1 });
        },
      },
    ],
    prompt: () => "increment",
    plan: ({ gap }) => (gap > 0 ? [{ kind: "increment", input: {} }] : []),
  };
  return { db, domain };
}

describe("UnmovedMover", () => {
  test("is frozen and behaviorless", () => {
    const m = new UnmovedMover({
      tenant: "t",
      version: 1,
      target: { goal: 5 },
    });
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      // @ts-expect-error — readonly, frozen
      m.version = 99;
    }).toThrow();
    expect(m.version).toBe(1);
  });
});

describe("InMemoryGoalLedger", () => {
  test("appends versions; current is latest; history is the lineage", () => {
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    const v1 = ledger.install("t", { goal: 5 });
    const v2 = ledger.install("t", { goal: 9 });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(ledger.latest("t").version).toBe(2);
    expect(ledger.history("t").map((m) => m.version)).toEqual([1, 2]);
  });

  test("old versions are untouched after a new install (succession, not mutation)", () => {
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    const v1 = ledger.install("t", { goal: 5 });
    ledger.install("t", { goal: 9 });
    expect(v1.target.goal).toBe(5);
  });

  test("current throws for an unknown tenant", () => {
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    expect(() => ledger.latest("nope")).toThrow();
  });
});

describe("Eudaimon.pursue", () => {
  test("publishes unmovedMover.reached when already satisfied", async () => {
    const { domain, db } = counterFixture();
    db.set("t", { value: 5 });
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 5 });
    const seen: string[] = [];
    bus.subscribe("unmovedMover.reached", async () => {
      seen.push("reached");
    });

    const agent = new Eudaimon("t", ledger, domain, bus, ruleDeliberator);
    await agent.pursue();
    expect(seen).toEqual(["reached"]);
  });

  test("deliberates and publishes eudaimon.pursued when there is a gap", async () => {
    const { domain } = counterFixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 3 });
    const pursued: string[] = [];
    bus.subscribe("eudaimon.pursued", async (e) => {
      pursued.push(e.summary);
    });

    const agent = new Eudaimon("t", ledger, domain, bus, ruleDeliberator);
    await agent.pursue();
    expect(pursued.length).toBe(1);
    expect(pursued[0]).toContain("increment");
  });
});

describe("wire — causal separation", () => {
  test("goal.updated installs a new version (the authority, never the agent)", async () => {
    const { domain } = counterFixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    wire({ bus, ledger, domain, deliberator: ruleDeliberator });

    await bus.publish({
      type: "goal.updated",
      tenant: "t",
      target: { goal: 2 },
    });
    expect(ledger.latest("t").target.goal).toBe(2);

    await bus.publish({
      type: "goal.updated",
      tenant: "t",
      target: { goal: 7 },
    });
    expect(ledger.history("t").map((m) => m.version)).toEqual([1, 2]);
    expect(ledger.latest("t").target.goal).toBe(7);
  });

  test("state.changed drives pursuit; the agent never authors the goal", async () => {
    const { domain, db } = counterFixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    wire({ bus, ledger, domain, deliberator: ruleDeliberator });
    ledger.install("t", { goal: 1 });

    await bus.publish({ type: "state.changed", tenant: "t" });
    expect(db.get("t")?.value).toBe(1);
    // goal version is unchanged — pursuit moved the world, not the goal
    expect(ledger.latest("t").version).toBe(1);
  });
});

describe("Deliberator port is swappable", () => {
  test("a custom deliberator is honored by Eudaimon", async () => {
    const { domain, db } = counterFixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 10 });

    const noop: Deliberator = {
      async run() {
        return { summary: "did nothing", actionsTaken: [] };
      },
    };
    const events: DomainEvent<CounterTarget>["type"][] = [];
    bus.subscribe("eudaimon.pursued", async () => {
      events.push("eudaimon.pursued");
    });

    const agent = new Eudaimon("t", ledger, domain, bus, noop);
    await agent.pursue();
    expect(db.get("t")?.value ?? 0).toBe(0);
    expect(events).toEqual(["eudaimon.pursued"]);
  });
});
