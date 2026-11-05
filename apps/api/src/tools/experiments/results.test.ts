import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as legacy from "../../deco-legacy/experiment-analytics";
import { getSettings, setGlobalSettings } from "../../settings";
import { EXPERIMENT_RESULTS } from "./results";

describe("EXPERIMENT_RESULTS", () => {
  const base = { site: "acme", key: "Cross Sell Bag" };

  it("rejects more than 20 goals", () => {
    const result = EXPERIMENT_RESULTS.inputSchema.safeParse({
      ...base,
      goals: Array.from({ length: 21 }, (_, i) => `goal-${i}`),
    });

    expect(result.success).toBe(false);
  });

  it("accepts 20 goals", () => {
    const result = EXPERIMENT_RESULTS.inputSchema.safeParse({
      ...base,
      goals: Array.from({ length: 20 }, (_, i) => `goal-${i}`),
    });

    expect(result.success).toBe(true);
  });

  it("rejects a reversed since/until range", () => {
    const result = EXPERIMENT_RESULTS.inputSchema.safeParse({
      ...base,
      since: "2026-02-01",
      until: "2026-01-01",
    });

    expect(result.success).toBe(false);
  });

  it("accepts an in-order since/until range", () => {
    const result = EXPERIMENT_RESULTS.inputSchema.safeParse({
      ...base,
      since: "2026-01-01",
      until: "2026-02-01",
    });

    expect(result.success).toBe(true);
  });
});

describe("EXPERIMENT_RESULTS fallback to Deco Analytics", () => {
  const original = getSettings();
  beforeAll(() =>
    setGlobalSettings({
      ...original,
      analyticsDataUrl: "https://analytics.test",
      analyticsMasterToken: "master-token",
    }),
  );
  afterAll(() => setGlobalSettings(original));

  const ctx = {
    auth: { user: { id: "user-1" } },
    access: { check: async () => {} },
    organization: { id: "org-1" },
    storage: {
      orgSites: {
        isOwnedBy: async () => false,
        getBySlug: async () => undefined,
      },
      virtualMcps: {
        list: async () => [
          {
            id: "p1",
            title: "acme",
            metadata: {
              siteSlug: "acme",
              decoAnalytics: { id: "s1", key: "dq_test" },
            },
          },
        ],
      },
      experiments: {
        getByKey: async () => ({
          goals: ["purchase"],
          variants: [
            { id: "a", weight: 50, role: "control" },
            { id: "b", weight: 50, role: "treatment" },
          ],
          startedAt: null,
        }),
      },
    },
  } as never;
  const input = EXPERIMENT_RESULTS.inputSchema.parse({
    site: "acme",
    key: "new-cart",
  });
  const decoPayload = {
    usageScope: { site: "s1", reader: "stats_reader", tenantScoped: true },
    expResults: [
      {
        variant: "a",
        visitors: "10",
        converters: { purchase: "1" },
        purchases: "1",
        revenue: 100,
      },
    ],
    expDaily: [],
  };
  const legacyResults = {
    visitors: { default: 3, variant: 4 },
    goals: [],
    timeseries: [],
    stats: {
      totalParticipants: 7,
      sampleSize: 1000,
      probabilityVariantBest: 0.5,
      probabilityDefaultBest: 0.5,
    },
  };

  it("answers from Deco Analytics when the legacy source has nothing", async () => {
    const legacySpy = spyOn(legacy, "queryExperimentResults").mockResolvedValue(
      { status: "no_site_data" },
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(decoPayload),
    );
    try {
      const out = await EXPERIMENT_RESULTS.handler(input, ctx);
      expect(out.available).toBe(true);
      expect(out.source).toBe("deco-analytics");
      expect(out.results?.visitors).toEqual({ default: 10, variant: 0 });
      expect(out.results?.arms?.map((a) => a.id)).toEqual(["a", "b"]);
    } finally {
      legacySpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("leaves a legacy answer untouched and never asks Deco Analytics", async () => {
    const legacySpy = spyOn(legacy, "queryExperimentResults").mockResolvedValue(
      { status: "ok", results: legacyResults },
    );
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      expect(await EXPERIMENT_RESULTS.handler(input, ctx)).toEqual({
        available: true,
        reason: null,
        analyticsSite: "acme",
        source: "legacy",
        results: legacyResults,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      legacySpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("answers as before when Deco Analytics fails", async () => {
    const legacySpy = spyOn(legacy, "queryExperimentResults").mockResolvedValue(
      { status: "not_configured" },
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("boom", { status: 502 }),
    );
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await EXPERIMENT_RESULTS.handler(input, ctx)).toEqual({
        available: false,
        reason: "not_configured",
        analyticsSite: "acme",
        results: null,
      });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      legacySpy.mockRestore();
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
