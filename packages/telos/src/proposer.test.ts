import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type Domain, Eudaimon, type GoalProposer, wire } from "./core";
import { inMemoryBus } from "./bus";
import { InMemoryGoalLedger } from "./ledger";
import { ruleDeliberator } from "./deliberate-rule";

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
    instructions: "increment toward the fixed goal",
    actions: [
      {
        kind: "increment",
        description: "increment by one",
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

// A proposer that hands back a fixed subordinate goal once (then null), so a
// single pursue() call is deterministic.
function onceProposer(
  target: CounterTarget,
): GoalProposer<CounterState, CounterTarget> {
  let done = false;
  return {
    propose: async () => {
      if (done) return null;
      done = true;
      return target;
    },
  };
}

describe("anchored proposing — mechanics", () => {
  test("an engine proposal installs as a subordinate; the anchor stays authority-owned", async () => {
    const { domain } = counterFixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 5 }); // authority anchor (and current goal)

    const proposed: CounterTarget[] = [];
    bus.subscribe("eudaimon.goal.proposed", async (e) => {
      proposed.push(e.target);
    });

    const agent = new Eudaimon({
      tenant: "t",
      ledger,
      domain,
      bus,
      deliberator: ruleDeliberator,
      proposer: onceProposer({ goal: 3 }),
    });
    await agent.pursue();

    expect(ledger.latest("t").target).toEqual({ goal: 3 });
    expect(ledger.latest("t").source).toBe("engine");
    expect(ledger.anchor("t").target).toEqual({ goal: 5 });
    expect(ledger.anchor("t").source).toBe("authority");
    expect(ledger.history("t").length).toBe(2);
    expect(proposed).toEqual([{ goal: 3 }]);
  });

  test("the proposer receives the fixed anchor, not the working goal", async () => {
    const { domain } = counterFixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 9 }); // authority anchor
    ledger.install("t", { goal: 4 }, "engine"); // current working goal (subordinate)

    let seenAnchor: CounterTarget | undefined;
    const proposer: GoalProposer<CounterState, CounterTarget> = {
      propose: async ({ anchor }) => {
        seenAnchor = anchor;
        return null;
      },
    };

    const agent = new Eudaimon({
      tenant: "t",
      ledger,
      domain,
      bus,
      deliberator: ruleDeliberator,
      proposer,
    });
    await agent.pursue();
    expect(seenAnchor).toEqual({ goal: 9 });
  });

  test("no proposer → no proposal, history unchanged", async () => {
    const { domain } = counterFixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 3 });
    let proposals = 0;
    bus.subscribe("eudaimon.goal.proposed", async () => {
      proposals++;
    });

    const agent = new Eudaimon({
      tenant: "t",
      ledger,
      domain,
      bus,
      deliberator: ruleDeliberator,
    });
    await agent.pursue();
    expect(ledger.history("t").length).toBe(1);
    expect(proposals).toBe(0);
  });

  test("proposer returning null installs nothing", async () => {
    const { domain } = counterFixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 3 });

    const agent = new Eudaimon({
      tenant: "t",
      ledger,
      domain,
      bus,
      deliberator: ruleDeliberator,
      proposer: { propose: async () => null },
    });
    await agent.pursue();
    expect(ledger.history("t").length).toBe(1);
  });
});

describe("anchored proposing — gating", () => {
  test("approveGoal=false rejects the proposal (not installed)", async () => {
    const { domain } = counterFixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 5 });
    const rejected: CounterTarget[] = [];
    bus.subscribe("eudaimon.goal.rejected", async (e) => {
      rejected.push(e.target);
    });

    const agent = new Eudaimon({
      tenant: "t",
      ledger,
      domain,
      bus,
      deliberator: ruleDeliberator,
      proposer: onceProposer({ goal: 3 }),
      approveGoal: async () => false,
    });
    await agent.pursue();
    expect(ledger.history("t").length).toBe(1);
    expect(ledger.latest("t").target).toEqual({ goal: 5 });
    expect(rejected).toEqual([{ goal: 3 }]);
  });

  test("approveGoal=true installs the proposal", async () => {
    const { domain } = counterFixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 5 });

    const agent = new Eudaimon({
      tenant: "t",
      ledger,
      domain,
      bus,
      deliberator: ruleDeliberator,
      proposer: onceProposer({ goal: 3 }),
      approveGoal: async () => true,
    });
    await agent.pursue();
    expect(ledger.latest("t").target).toEqual({ goal: 3 });
    expect(ledger.latest("t").source).toBe("engine");
  });
});

describe("anchored proposing — climb stays within the anchor", () => {
  test("engine raises working goals toward the anchor and never past it", async () => {
    const { db, domain } = counterFixture();
    const bus = inMemoryBus<CounterTarget>();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    db.set("t", { value: 0 });
    ledger.install("t", { goal: 9 }); // authority anchor / ceiling

    // Decompose: aim a few steps ahead of the world, clamped to the anchor.
    const proposer: GoalProposer<CounterState, CounterTarget> = {
      propose: async ({ state, current, anchor }) => {
        const next = Math.min(state.value + 3, anchor.goal);
        return next === current.goal ? null : { goal: next };
      },
    };
    wire({ bus, ledger, domain, deliberator: ruleDeliberator, proposer });

    for (let i = 0; i < 40 && (db.get("t")?.value ?? 0) < 9; i++) {
      await bus.publish({ type: "state.changed", tenant: "t" });
    }

    expect(db.get("t")?.value).toBeGreaterThanOrEqual(9);
    expect(ledger.anchor("t").target).toEqual({ goal: 9 });
    expect(ledger.anchor("t").source).toBe("authority");

    const engineGoals = ledger
      .history("t")
      .filter((m) => m.source === "engine");
    expect(engineGoals.length).toBeGreaterThan(0);
    for (const m of engineGoals) {
      expect(m.target.goal).toBeLessThanOrEqual(9); // never exceeded the anchor
    }
  });
});
