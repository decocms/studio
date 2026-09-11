import { afterAll, describe, expect, it, mock } from "bun:test";
import { getSettings, setGlobalSettings } from "@/settings";
import { resolveConfig } from "@/settings/resolve-config";
import type { Settings } from "@/settings/types";

/**
 * Plans ON for this file, through the real settings pipeline and the real
 * setter — NOT `mock.module("@/settings")`.
 *
 * Both matter. Bun's module mocks are PROCESS-WIDE, so stubbing the settings
 * module leaks into every suite that runs after it; and a PARTIAL settings
 * object leaks just as badly, because `/api/config` and the provider schemas
 * read fields this file never mentions. So: build a complete Settings with
 * `resolveConfig`, flip the two flags this file needs, and restore whatever was
 * there afterwards.
 */
function plansOnSettings() {
  const { settings } = resolveConfig(
    { port: "", home: "", localMode: false, skipMigrations: false },
    {
      STUDIO_PLANS_ENABLED: "true",
      STUDIO_JWT_SECRET: "test-shared-secret",
      STUDIO_PROVISION_SECRET_KEY: "test-service-key",
      DECO_AI_GATEWAY_ENABLED: "true",
    },
  );
  // resolveConfig omits the two fields the startup pipeline fills in later;
  // nothing here reads them.
  return { ...settings, databaseUrl: "", natsUrls: [] } as Settings;
}

const previousSettings = (() => {
  try {
    return getSettings();
  } catch {
    return null;
  }
})();
setGlobalSettings(plansOnSettings());
afterAll(() => {
  if (previousSettings) setGlobalSettings(previousSettings);
});

let entitlements: unknown = { features: { kanban: true } };
let failEntitlements = false;

// The gateway adapter's own method is swapped, not the whole module: one
// property on the singleton the registry returns, restored after the file.
const { decoAiGatewayAdapter } = await import(
  "@/ai-providers/adapters/deco-ai-gateway"
);
const realGetEntitlements = decoAiGatewayAdapter.getEntitlements;
(decoAiGatewayAdapter as { getEntitlements: unknown }).getEntitlements =
  async () => {
    if (failEntitlements) throw new Error("gateway unreachable");
    return entitlements;
  };
afterAll(() => {
  (decoAiGatewayAdapter as { getEntitlements: unknown }).getEntitlements =
    realGetEntitlements;
});

const jwt = await import("@/auth/jwt");
mock.module("@/auth/jwt", () => ({
  ...jwt,
  mintGatewayJwt: async () => "jwt",
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

  /**
   * Past the gate, the dispatch needs a real org context, tier resolution and
   * storage — out of scope here, and stubbing it would only assert the stubs.
   * So these two assert what this test is about: the call is NOT refused by the
   * plan gate. Anything it fails on afterwards is the dispatch's own business.
   */
  const notRefused = async () => {
    const err = await enqueueAgentRunForTask(ctx(), task, opts).catch(
      (e: Error) => e,
    );
    expect((err as Error)?.name).not.toBe("FeatureNotInPlanError");
    expect((err as Error)?.name).not.toBe("AiBudgetExhaustedError");
  };

  it("lets an org that owns kanban through", async () => {
    entitlements = { features: { kanban: true } };
    invalidateOrgFeaturesCache("org_1");
    await notRefused();
  });

  it("lets the call through when the gateway has no answer — fails open", async () => {
    failEntitlements = true;
    invalidateOrgFeaturesCache("org_1");
    await notRefused();
    failEntitlements = false;
  });
});
