import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type Domain, Eudaimon, InMemoryGoalLedger } from "../core";
import { ruleDeliberator } from "../deliberators/rule";
import { type Daimonion, guardedBy, guardTools } from "./daimonion";

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
  test("a vetoed action never applies and is reported as vetoed", async () => {
    const { db, domain } = fixture();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 3 });
    db.set("t", { value: 0 });

    const daimonion: Daimonion = {
      veto: async ({ kind }) =>
        kind === "increment" ? { reason: "forbidden" } : null,
    };

    const agent = new Eudaimon({
      tenant: "t",
      ledger,
      domain: guardedBy(daimonion)(domain),
      deliberator: ruleDeliberator,
    });
    const outcome = await agent.pursue();

    expect(db.get("t")?.value).toBe(0); // side effect blocked
    expect(outcome.applied).toEqual([]); // not recorded as applied
    expect(outcome.vetoed.map((v) => `${v.kind}:${v.reason}`)).toEqual([
      "increment:forbidden",
    ]);
  });

  test("a silent daimonion (null) allows the action through", async () => {
    const { db, domain } = fixture();
    const ledger = new InMemoryGoalLedger<CounterTarget>();
    ledger.install("t", { goal: 3 });
    db.set("t", { value: 0 });

    const daimonion: Daimonion = { veto: async () => null };
    const agent = new Eudaimon({
      tenant: "t",
      ledger,
      domain: guardedBy(daimonion)(domain),
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
      deliberator: ruleDeliberator,
    });
    await agent.pursue();

    expect(db.get("t")?.value).toBe(1); // safe applied (+1), risky vetoed (+100 blocked)
  });
});

describe("daimonion — guardTools (host agent's tools)", () => {
  const ran: string[] = [];
  const tools = {
    safe_tool: {
      description: "ok",
      execute: async (input: unknown, _options: unknown) => {
        ran.push("safe_tool");
        return `did safe with ${JSON.stringify(input)}`;
      },
    },
    risky_tool: {
      description: "danger",
      execute: async (_input: unknown, _options: unknown) => {
        ran.push("risky_tool");
        return "did risky";
      },
    },
    no_exec_tool: { description: "client-side only" },
  };

  test("a vetoed tool never executes and returns a refusal result", async () => {
    ran.length = 0;
    const daimonion: Daimonion = {
      veto: async ({ kind }) =>
        kind === "risky_tool" ? { reason: "too risky" } : null,
    };
    const guarded = guardTools(tools, daimonion, "agent-1");

    const safe = await guarded.safe_tool.execute?.({ a: 1 }, {});
    const risky = await guarded.risky_tool.execute?.({}, {});

    expect(safe).toBe('did safe with {"a":1}');
    expect(risky).toBe("Action vetoed (risky_tool): too risky");
    expect(ran).toEqual(["safe_tool"]); // risky never ran its side effect
  });

  test("the veto sees the tool name as `kind` and the call args as `input`", async () => {
    const seen: Array<{ kind: string; tenant: string; input: unknown }> = [];
    const daimonion: Daimonion = {
      veto: async (a) => {
        seen.push(a);
        return null;
      },
    };
    const guarded = guardTools(tools, daimonion, "agent-7");
    await guarded.safe_tool.execute?.({ x: "y" }, {});
    expect(seen).toEqual([
      { kind: "safe_tool", tenant: "agent-7", input: { x: "y" } },
    ]);
  });

  test("tools without an execute (client-side) pass through untouched", () => {
    const daimonion: Daimonion = { veto: async () => null };
    const guarded = guardTools(tools, daimonion, "agent-1");
    expect(guarded.no_exec_tool).toBe(tools.no_exec_tool);
  });
});
