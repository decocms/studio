/**
 * The WIRING between a `requiresFeature` declaration and a refusal.
 *
 * A mutation audit of this branch found that `isFeatureAllowed` could be
 * replaced with `return true`, and that `define-tool.ts`'s enforcement block
 * could be disabled with a `false &&`, with the entire API suite green: the
 * predicates were well covered and nothing asserted that DECLARING a feature
 * stops a call. Neither `FeatureNotInPlanError` nor `AiBudgetExhaustedError`
 * was named by any test.
 *
 * So this mounts a real `defineTool` and runs it, stubbing only the three
 * seams below `getOrgPlanState` — settings, the provider registry, the JWT
 * mint. The cache, the stale rules, the error classes and the throw sites are
 * the real code under test.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { z } from "zod";
import type { StudioContext } from "./studio-context";

let entitlements: unknown = { features: { cms: true } };
let fail: Error | null = null;

mock.module("../settings", () => ({
  getSettings: () => ({ plansEnabled: true, aiGatewayEnabled: true }),
}));
mock.module("../auth/jwt", () => ({ mintGatewayJwt: async () => "jwt" }));
// The org-block gate runs first in the same wrapper and reads the database.
// Not what these tests are about; stub it open.
mock.module("./org-notice-gate", () => ({
  isOrgBlocked: async () => false,
  isToolAllowedWhileBlocked: () => false,
  OrgBlockedError: class OrgBlockedError extends Error {},
}));
mock.module("../ai-providers/registry", () => ({
  getProviders: () => ({
    deco: {
      getEntitlements: async () => {
        if (fail) throw fail;
        return entitlements;
      },
    },
  }),
}));

const { invalidateOrgFeaturesCache, FeatureNotInPlanError } = await import(
  "./plan-feature-gate"
);
const { EntitlementsFetchError } = await import(
  "../ai-providers/adapters/deco-ai-gateway"
);
const { defineTool } = await import("./define-tool");

function ctx(): StudioContext {
  return {
    organization: { id: "org_1", slug: "o", name: "O" },
    auth: { user: { id: "u1" } },
    access: {
      granted: () => true,
      check: async () => {},
      grant: () => {},
      setToolName: () => {},
    },
    timings: {
      measure: async <T>(_n: string, cb: () => Promise<T>) => await cb(),
    },
    tracer: {
      startActiveSpan: (
        _n: string,
        _o: unknown,
        fn: (span: unknown) => unknown,
      ) =>
        fn({
          setStatus: () => {},
          recordException: () => {},
          end: () => {},
        }),
    },
    db: {} as never,
    storage: {} as never,
  } as unknown as StudioContext;
}

const gated = defineTool({
  name: "TEST_GATED",
  description: "d",
  inputSchema: z.object({}),
  outputSchema: z.object({ ran: z.boolean() }),
  requiresFeature: "cms",
  handler: async () => ({ ran: true }),
});

const spender = defineTool({
  name: "TEST_SPENDER",
  description: "d",
  inputSchema: z.object({}),
  outputSchema: z.object({ ran: z.boolean() }),
  requiresAiBudget: true,
  handler: async () => ({ ran: true }),
});

beforeEach(() => {
  fail = null;
  entitlements = { features: { cms: true } };
  invalidateOrgFeaturesCache("org_1");
});

describe("requiresFeature is the gate", () => {
  it("refuses when the plan does not include the feature", async () => {
    entitlements = { features: { cms: false } };
    await expect(gated.execute({}, ctx())).rejects.toThrow(
      FeatureNotInPlanError,
    );
  });

  it("refuses when the feature key is ABSENT, not merely false", async () => {
    // The gateway's contract: absent means denied, never "unknown".
    entitlements = { features: { chat: true } };
    await expect(gated.execute({}, ctx())).rejects.toThrow(
      /needs the cms feature/,
    );
  });

  it("runs when the plan includes it", async () => {
    expect(await gated.execute({}, ctx())).toEqual({ ran: true });
  });

  it("runs when the gateway cannot be read — the gate fails OPEN", async () => {
    fail = new EntitlementsFetchError(503);
    expect(await gated.execute({}, ctx())).toEqual({ ran: true });
  });

  it("runs when a 200 arrives with no features map, and does not cache it", async () => {
    // A malformed body used to become `features: undefined`, which reads as
    // "no answer" (open) AND was written to the cache, so every gate opened
    // for the full TTL with nothing logged.
    entitlements = { usage: { state: "ok" } };
    expect(await gated.execute({}, ctx())).toEqual({ ran: true });
    // The next call re-reads rather than serving a cached "everything open".
    entitlements = { features: { cms: false } };
    await expect(gated.execute({}, ctx())).rejects.toThrow(
      FeatureNotInPlanError,
    );
  });
});

describe("requiresAiBudget is the stop", () => {
  it("refuses an exhausted bar with no purchased credit", async () => {
    entitlements = {
      features: {},
      usage: { state: "exhausted" },
      credits: { remainingUsd: 0 },
    };
    await expect(spender.execute({}, ctx())).rejects.toThrow(
      /allowance|exhaust/i,
    );
  });

  it("lets an exhausted org spend the credit it bought", async () => {
    entitlements = {
      features: {},
      usage: { state: "exhausted" },
      credits: { remainingUsd: 25 },
    };
    expect(await spender.execute({}, ctx())).toEqual({ ran: true });
  });

  it("treats an unreadable bar as unknown, never as exhausted", async () => {
    entitlements = { features: {}, usage: null, credits: null };
    expect(await spender.execute({}, ctx())).toEqual({ ran: true });
  });
});
