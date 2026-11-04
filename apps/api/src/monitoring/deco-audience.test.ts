import { expect, it, mock } from "bun:test";

let rows: Record<string, unknown>[] = [];
let lastParams: Record<string, unknown> | undefined;

mock.module("../customer-lake/client", () => ({
  queryCustomerLake: async (
    _org: string,
    _sql: string,
    params?: Record<string, unknown>,
  ) => {
    lastParams = params;
    return rows;
  },
}));

const { loadDecoAudience, toAudienceData } = await import("./deco-audience");

const DAY = {
  since: "2026-10-28",
  until: "2026-10-28",
  granularity: "hourly",
} as const;

it("answers kpis in the OneDollarStats positions, zero when nothing synced", async () => {
  rows = [];
  expect(await loadDecoAudience("org", "s1", "kpis", DAY, "UTC")).toEqual([
    { dimensions: [], metrics: [0, 0, 0, 0, 0] },
  ]);
  // UInt64 arrives as a string in JSONEachRow.
  rows = [{ visitors: "4", pageviews: "10" }];
  expect(await loadDecoAudience("org", "s1", "kpis", DAY, "UTC")).toEqual([
    { dimensions: [], metrics: [4, 0, 10, 0, 0] },
  ]);
});

it("lists timeseries as [pageviews, visits, visitors, …]", async () => {
  rows = [{ bucket: "2026-10-28 17:00:00", visitors: "4", pageviews: "10" }];
  expect(
    await loadDecoAudience("org", "s1", "timeseries", DAY, "America/Sao_Paulo"),
  ).toEqual([
    { dimensions: ["2026-10-28 17:00:00"], metrics: [10, 0, 4, 0, 0] },
  ]);
});

it("reads each breakdown from its dimension with the report's metric order", async () => {
  rows = [{ value: "/", visitors: "1", pageviews: "6", events: "12" }];
  expect(await loadDecoAudience("org", "s1", "pages", DAY, "UTC")).toEqual([
    { dimensions: ["/"], metrics: [6, 1] },
  ]);
  expect(lastParams?.dim).toBe("path");
  expect(await loadDecoAudience("org", "s1", "events", DAY, "UTC")).toEqual([
    { dimensions: ["/"], metrics: [1, 12] },
  ]);
  expect(lastParams?.dim).toBe("name");
});

it("has nothing for UTM fields the collector doesn't keep", async () => {
  rows = [{ value: "x", visitors: "1", pageviews: "1", events: "1" }];
  expect(await loadDecoAudience("org", "s1", "utm_term", DAY, "UTC")).toEqual(
    [],
  );
});

it("maps the lake's positional rows to the audience contract", () => {
  const kpis = [{ dimensions: [], metrics: [10, 0, 30, 0, 0] }];
  expect(toAudienceData("summary", kpis, null)).toEqual({
    view: "summary",
    summary: {
      visitors: 10,
      pageviews: 30,
      sessions: null,
      bounceRate: null,
      visitDurationS: null,
    },
    previous: null,
  });
  expect(
    toAudienceData(
      "timeline",
      [{ dimensions: ["2026-11-04"], metrics: [30, 0, 10, 0, 0] }],
      null,
    ),
  ).toEqual({
    view: "timeline",
    points: [{ t: "2026-11-04", visitors: 10, pageviews: 30 }],
  });
  expect(
    toAudienceData("pages", [{ dimensions: ["/"], metrics: [7, 3] }], null),
  ).toEqual({ view: "pages", rows: [{ key: "/", count: 7 }] });
  expect(toAudienceData("summary", [], null)).toMatchObject({
    summary: { visitors: 0, pageviews: 0 },
  });
});
