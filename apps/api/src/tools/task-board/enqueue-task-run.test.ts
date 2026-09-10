import { describe, expect, it, mock } from "bun:test";

// Stub the three seams under the plan gate (settings, the provider registry,
// the JWT mint) plus the tier resolution the dispatch does after it. Everything
// between — the cache, the fail-open rules, the error classes — is real.
let entitlements: unknown = { features: { kanban: true } };
let failEntitlements = false;

const settings = await import("@/settings");
mock.module("@/settings", () => ({
  ...settings,
  // A literal, not a spread of the real settings: outside a request there are
  // none, and reading them throws.
  getSettings: () => ({ plansEnabled: true, aiGatewayEnabled: true }),
}));
// Partial: this module has other exports the dispatch path's imports need.
const jwt = await import("@/auth/jwt");
mock.module("@/auth/jwt", () => ({
  ...jwt,
  mintGatewayJwt: async () => "jwt",
}));
const registry = await import("@/ai-providers/registry");
mock.module("@/ai-providers/registry", () => ({
  ...registry,
  getProviders: () => ({
    deco: {
      getEntitlements: async () => {
        if (failEntitlements) throw new Error("gateway unreachable");
        return entitlements;
      },
    },
  }),
}));
const tier = await import("@/core/resolve-tier");
mock.module("@/core/resolve-tier", () => ({
  ...tier,
  resolveTier: async () => null,
}));

const { enqueueAgentRunForTask, withOrgTaskPrompt } = await import(
  "./enqueue-task-run"
);
const { invalidateOrgFeaturesCache } = await import("@/core/plan-feature-gate");

type Agent = { instructions?: string; appendInstructions?: string };

describe("withOrgTaskPrompt", () => {
  const reviewer: { agent: Agent | undefined; prompt: string } = {
    agent: { instructions: "You review PRs." },
    prompt: "Do it.",
  };
  const superAgent: { agent: Agent | undefined; prompt: string } = {
    agent: undefined,
    prompt: "Do it.",
  };

  it("leaves the run untouched when the board has no prompt", () => {
    expect(withOrgTaskPrompt(reviewer, undefined, true)).toBe(reviewer);
    expect(withOrgTaskPrompt(reviewer, "", false)).toBe(reviewer);
  });

  it("rides as appendInstructions on a sandbox run", () => {
    const out = withOrgTaskPrompt(superAgent, "Use pnpm.", true);
    expect(out.agent?.appendInstructions).toBe("Use pnpm.");
    expect(out.prompt).toBe("Do it.");
  });

  /** The whole point of the append field: a Super Agent run sets no
   *  `instructions`, so writing the board prompt there would make
   *  dispatch-run's `input.agent.instructions ?? virtualMcp.instructions`
   *  resolve to the board prompt and silently drop the agent's own persona. */
  it("never sets instructions, so the agent's own survive", () => {
    const out = withOrgTaskPrompt(superAgent, "Use pnpm.", true);
    expect(out.agent?.instructions).toBeUndefined();
  });

  it("leaves an explicit persona override intact alongside the append", () => {
    const out = withOrgTaskPrompt(reviewer, "Use pnpm.", true);
    expect(out.agent?.instructions).toBe("You review PRs.");
    expect(out.agent?.appendInstructions).toBe("Use pnpm.");
  });

  it("leads the prompt on a hosted run, which reads no append field", () => {
    const out = withOrgTaskPrompt(reviewer, "Use pnpm.", false);
    expect(out.agent).toBe(reviewer.agent);
    expect(out.agent?.appendInstructions).toBeUndefined();
    expect(out.prompt).toBe("Use pnpm.\n\nDo it.");
  });
});

/**
 * The Kanban gate, at the dispatch.
 *
 * `kanban` is an Ultra feature and was enforced ONLY by the client's tab
 * paywall — while every TASK_BOARD_* tool sits in the basic-usage capability,
 * granted to every member of every org. So a Free org could create a card and
 * re-run it straight through the tool REST endpoint and get a working, unbilled
 * agent fleet. The gateway even built a chokepoint for this
 * (`POST /api/teams/:org/tasks/claim`, with its 402 and trial grants) and mesh
 * never called it.
 */
describe("enqueueAgentRunForTask plan gate", () => {
  const task = {
    id: "task_1",
    organizationId: "org_1",
    status: "todo",
    createdBy: "u1",
    assignedBy: null,
  } as never;

  const opts = { title: "t", prompt: "p", temperature: 0 };

  function ctx(): never {
    return {
      auth: { user: { id: "u1" } },
      storage: {
        taskBoardPrompts: { promptFor: async () => undefined },
        // Reached only if the gate allows. `isNew: false` makes the function
        // return right there, so nothing further needs stubbing.
        threads: { create: async () => ({ id: "thread_1", isNew: false }) },
      },
      db: {},
    } as never;
  }

  it("refuses a plan without kanban, before anything is dispatched", async () => {
    entitlements = { features: { kanban: false } };
    invalidateOrgFeaturesCache("org_1");
    await expect(enqueueAgentRunForTask(ctx(), task, opts)).rejects.toThrow(
      /kanban/,
    );
  });

  it("refuses an exhausted AI envelope with no purchased credit", async () => {
    entitlements = {
      features: { kanban: true },
      usage: { state: "exhausted" },
      credits: { remainingUsd: 0 },
    };
    invalidateOrgFeaturesCache("org_1");
    await expect(enqueueAgentRunForTask(ctx(), task, opts)).rejects.toThrow(
      /allowance|exhaust/i,
    );
  });

  it("dispatches for an org that owns kanban", async () => {
    entitlements = { features: { kanban: true } };
    invalidateOrgFeaturesCache("org_1");
    expect(await enqueueAgentRunForTask(ctx(), task, opts)).toEqual({
      threadId: "thread_1",
      isNew: false,
    });
  });

  it("dispatches when the gateway has no answer — the gate fails open", async () => {
    failEntitlements = true;
    invalidateOrgFeaturesCache("org_1");
    expect(await enqueueAgentRunForTask(ctx(), task, opts)).toEqual({
      threadId: "thread_1",
      isNew: false,
    });
    failEntitlements = false;
  });
});
