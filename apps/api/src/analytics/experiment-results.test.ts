import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { StudioContext } from "../core/studio-context";
import { pBetter } from "../deco-legacy/ab-test";
import { getSettings, setGlobalSettings } from "../settings";
import {
  decoGoals,
  decoWindow,
  readDecoExperimentResults,
} from "./experiment-results";

const ORG = "org-1";
const NOW = new Date("2026-03-10T15:42:00Z");

/** The read surface's `experimentResults` payload as it answers: UInt64 as
 *  strings, revenue as a number, behaviour per arm. Synthetic values. */
const recordedPayload = {
  usageScope: { site: "s1", reader: "stats_reader", tenantScoped: true },
  window: {
    from: "2026-03-08T00:00:00.000Z",
    to: "2026-03-11T00:00:00.000Z",
    tz: "UTC",
  },
  experiment: { key: "new-cart", goals: ["purchase", "experience_impression"] },
  expResults: [
    {
      variant: "new",
      visitors: "200",
      converters: { purchase: "5", experience_impression: "20" },
      purchases: "6",
      revenue: 1200.25,
      exposed: "20",
      convertersExposed: { purchase: "4", experience_impression: "20" },
    },
    {
      variant: "old",
      visitors: "1000",
      converters: { purchase: "20", experience_impression: "100" },
      purchases: "21",
      revenue: 5000.5,
      exposed: "100",
      convertersExposed: { purchase: "15", experience_impression: "100" },
    },
  ],
  expDaily: [
    {
      day: "2026-03-09",
      variant: "old",
      visitors: "600",
      converters: { purchase: "12", experience_impression: "60" },
      purchases: "12",
      revenue: 3000,
      exposed: "60",
      convertersExposed: { purchase: "9", experience_impression: "60" },
    },
    {
      day: "2026-03-08",
      variant: "new",
      visitors: "80",
      converters: { purchase: "2", experience_impression: "8" },
      purchases: "2",
      revenue: 400,
      exposed: "8",
      convertersExposed: { purchase: "2", experience_impression: "8" },
    },
    {
      day: "2026-03-08",
      variant: "old",
      visitors: "400",
      converters: { purchase: "8", experience_impression: "40" },
      purchases: "9",
      revenue: 2000.5,
      exposed: "40",
      convertersExposed: { purchase: "6", experience_impression: "40" },
    },
  ],
  expBehaviour: [
    {
      variant: "old",
      visitors: "1000",
      pageviewsPerVisitor: 4.89,
      activeSecondsPerVisitor: 97.2,
      clicksPerVisitor: 7.59,
      medianScrollDepth: 38,
      errorPct: 2.2,
    },
  ],
};

/** An org whose project carries the external registration `s1` for `acme`. */
function analyticsCtx(opts: { registered?: boolean } = {}) {
  return {
    storage: {
      orgSites: {
        isOwnedBy: async () => false,
        getBySlug: async () => undefined,
      },
      virtualMcps: {
        list: async () =>
          opts.registered === false
            ? []
            : [
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
    },
  } as unknown as StudioContext;
}

const input = {
  slug: "acme",
  key: "new-cart",
  goals: ["experience_impression", "visitors", "Not An Event"],
  goalOnDash: "visitors",
  variants: [
    { id: "old", role: "control" },
    { id: "new", role: "treatment" },
    { id: "unused", role: null },
  ],
  startedAt: "2026-03-08T14:40:00Z",
};

describe("decoGoals / decoWindow", () => {
  it("keeps valid event names, purchase first", () => {
    expect(
      decoGoals(["add_to_cart", "visitors", "Cross Sell", "purchase"]),
    ).toEqual(["purchase", "add_to_cart"]);
  });

  it("reads from the experiment's start hour to now's, at most 31 days", () => {
    expect(decoWindow({ startedAt: "2026-03-08T14:40:00Z" }, NOW)).toEqual({
      from: "2026-03-08T14:00:00.000Z",
      to: "2026-03-10T15:00:00.000Z",
    });
    expect(decoWindow({ startedAt: null }, NOW).from).toBe(
      "2026-02-08T15:00:00.000Z",
    );
    expect(decoWindow({ startedAt: "2025-01-01T00:00:00Z" }, NOW).from).toBe(
      "2026-02-07T15:00:00.000Z",
    );
    expect(
      decoWindow(
        { startedAt: null, since: "2026-03-01", until: "2026-03-02" },
        NOW,
      ),
    ).toEqual({
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-03T00:00:00.000Z",
    });
  });
});

describe("readDecoExperimentResults", () => {
  const original = getSettings();
  beforeAll(() =>
    setGlobalSettings({
      ...original,
      analyticsDataUrl: "https://analytics.test",
      analyticsMasterToken: "master-token",
    }),
  );
  afterAll(() => setGlobalSettings(original));

  it("maps a recorded response onto the configured arms", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(recordedPayload),
    );
    try {
      const out = await readDecoExperimentResults(
        analyticsCtx(),
        ORG,
        input,
        NOW,
      );
      const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
      expect(Object.fromEntries(url.searchParams)).toEqual({
        view: "experimentResults",
        site: "s1",
        experiment: "new-cart",
        from: "2026-03-08T14:00:00.000Z",
        to: "2026-03-10T15:00:00.000Z",
        goals: "purchase,experience_impression",
        exposure: "experience_impression",
        behaviour: "true",
      });
      expect(out?.visitors).toEqual({ default: 1000, variant: 200 });
      expect(out?.goals).toEqual([
        { goal: "visitors", default: 1000, variant: 200 },
        { goal: "purchase", default: 20, variant: 5 },
        { goal: "experience_impression", default: 100, variant: 20 },
      ]);
      expect(out?.timeseries).toEqual([
        { date: "2026-03-08", default: 400, variant: 80 },
        { date: "2026-03-09", default: 600, variant: 0 },
      ]);
      expect(out?.statsGoal).toBe("purchase");
      expect(out?.arms).toEqual([
        {
          id: "old",
          visitors: 1000,
          converters: 20,
          exposed: 100,
          convertersAmongExposed: 15,
          purchases: 21,
          revenue: 5000.5,
          behaviour: {
            pageviewsPerVisitor: 4.89,
            activeSecondsPerVisitor: 97.2,
            clicksPerVisitor: 7.59,
            medianScrollDepth: 38,
            errorPct: 2.2,
          },
          // Sorted by day although the payload is not.
          daily: [
            {
              date: "2026-03-08",
              visitors: 400,
              exposed: 40,
              converters: 8,
              convertersAmongExposed: 6,
            },
            {
              date: "2026-03-09",
              visitors: 600,
              exposed: 60,
              converters: 12,
              convertersAmongExposed: 9,
            },
          ],
        },
        {
          id: "new",
          visitors: 200,
          converters: 5,
          exposed: 20,
          convertersAmongExposed: 4,
          purchases: 6,
          revenue: 1200.25,
          behaviour: null,
          daily: [
            {
              date: "2026-03-08",
              visitors: 80,
              exposed: 8,
              converters: 2,
              convertersAmongExposed: 2,
            },
          ],
        },
        {
          id: "unused",
          visitors: 0,
          converters: 0,
          exposed: 0,
          convertersAmongExposed: 0,
          purchases: 0,
          revenue: 0,
          behaviour: null,
          daily: [],
        },
      ]);
      expect(out?.currency).toBeNull();
      // Among the exposed, not among every visitor.
      expect(out?.stats.totalParticipants).toBe(1200);
      expect(out?.stats.probabilityVariantBest).toBe(
        pBetter({ successes: 15, total: 100 }, { successes: 4, total: 20 }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("compares visitors when no exposure was asked", async () => {
    const plain = {
      ...recordedPayload,
      currency: "BRL",
      expResults: recordedPayload.expResults.map(
        ({ exposed: _e, convertersExposed: _c, ...r }) => r,
      ),
    };
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(plain),
    );
    try {
      const out = await readDecoExperimentResults(
        analyticsCtx(),
        ORG,
        { ...input, goals: [] },
        NOW,
      );
      expect(
        new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.has(
          "exposure",
        ),
      ).toBe(false);
      expect(out?.arms?.[0]?.exposed).toBeNull();
      expect(out?.currency).toBe("BRL");
      expect(out?.arms?.[0]?.daily[0]).toEqual({
        date: "2026-03-08",
        visitors: 400,
        exposed: null,
        converters: 8,
        convertersAmongExposed: null,
      });
      expect(out?.stats.probabilityVariantBest).toBe(
        pBetter({ successes: 20, total: 1000 }, { successes: 5, total: 200 }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("never calls the read surface for a site the org cannot read", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      expect(
        await readDecoExperimentResults(
          analyticsCtx({ registered: false }),
          ORG,
          input,
          NOW,
        ),
      ).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("answers null on an error, an unscoped payload, no rows, or a key it can't read", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = spyOn(globalThis, "fetch");
    const read = (key = input.key) =>
      readDecoExperimentResults(analyticsCtx(), ORG, { ...input, key }, NOW);
    try {
      fetchSpy.mockResolvedValueOnce(
        Response.json({ error: "boom" }, { status: 500 }),
      );
      expect(await read()).toBeNull();
      fetchSpy.mockRejectedValueOnce(new Error("network down"));
      expect(await read()).toBeNull();
      fetchSpy.mockResolvedValueOnce(
        Response.json({
          ...recordedPayload,
          usageScope: {
            site: "s2",
            reader: "stats_reader",
            tenantScoped: true,
          },
        }),
      );
      expect(await read()).toBeNull();
      fetchSpy.mockResolvedValueOnce(
        Response.json({ ...recordedPayload, expResults: [] }),
      );
      expect(await read()).toBeNull();
      fetchSpy.mockClear();
      expect(await read("Cross Sell Bag")).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
