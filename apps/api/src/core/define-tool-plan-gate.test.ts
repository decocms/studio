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
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { getSettings, setGlobalSettings } from "../settings";
import { resolveConfig } from "../settings/resolve-config";
import type { Settings } from "../settings/types";
import { z } from "zod";
import type { StudioContext } from "./studio-context";

let entitlements: unknown = { features: { cms: true } };
let fail: Error | null = null;

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

// The gateway adapter's own method, swapped on the singleton the registry
// returns and restored after the file — one property, not a whole module.
const { decoAiGatewayAdapter } = await import(
  "../ai-providers/adapters/deco-ai-gateway"
);
const realGetEntitlements = decoAiGatewayAdapter.getEntitlements;
(decoAiGatewayAdapter as { getEntitlements: unknown }).getEntitlements =
  async () => {
    if (fail) throw fail;
    return entitlements;
  };
afterAll(() => {
  (decoAiGatewayAdapter as { getEntitlements: unknown }).getEntitlements =
    realGetEntitlements;
});

const jwtModule = await import("../auth/jwt");
mock.module("../auth/jwt", () => ({
  ...jwtModule,
  mintGatewayJwt: async () => "jwt",
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
    // The org-block gate runs first in the same wrapper and reads
    // `organization_notices`. Answered here rather than by mocking that module:
    // bun's `mock.module` is process-wide, and stubbing it broke
    // org-notice-gate's own suite when both ran in the same process.
    db: {
      selectFrom: () => ({
        selectAll: () => ({
          where: () => ({
            where: () => ({ executeTakeFirst: async () => undefined }),
          }),
        }),
      }),
    } as never,
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
