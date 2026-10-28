import { describe, expect, test } from "bun:test";
import {
  decoBreakdown,
  decoSummary,
  decoTimeline,
  oneDollarRows,
  oneDollarSummary,
  oneDollarTimeline,
  oneDollarWindow,
  pickAudienceSource,
} from "./monitor-audience";

describe("pickAudienceSource", () => {
  test("a Deco Analytics registration wins over a OneDollarStats host", () => {
    expect(pickAudienceSource("registered", "www.example.test")).toBe(
      "deco-analytics",
    );
  });

  test("an unregistered site falls back to OneDollarStats", () => {
    expect(pickAudienceSource("unregistered", "www.example.test")).toBe(
      "onedollar",
    );
    expect(pickAudienceSource("not-configured", "www.example.test")).toBe(
      "onedollar",
    );
  });

  test("no registration and no host is no source", () => {
    expect(pickAudienceSource("unregistered", null)).toBeNull();
    expect(pickAudienceSource("not-configured", null)).toBeNull();
  });
});

describe("oneDollarWindow", () => {
  const now = new Date("2026-03-01T15:30:00Z");

  test("24h is today so far, bucketed by hour, compared with yesterday", () => {
    expect(oneDollarWindow("24h", now)).toEqual({
      since: "2026-03-01",
      until: "2026-03-01",
      previous: ["2026-02-28", "2026-02-28"],
      bucket: "time:hour",
    });
  });

  test("7d spans seven inclusive days and the seven before them", () => {
    expect(oneDollarWindow("7d", now)).toEqual({
      since: "2026-02-23",
      until: "2026-03-01",
      previous: ["2026-02-16", "2026-02-22"],
      bucket: "time:day",
    });
  });

  test("30d crosses a month boundary", () => {
    const w = oneDollarWindow("30d", now);
    expect(w.since).toBe("2026-01-31");
    expect(w.previous).toEqual(["2026-01-01", "2026-01-30"]);
  });
});

describe("OneDollarStats normalizers", () => {
  test("summary reads metrics in query order and keeps unreported ones null", () => {
    expect(
      oneDollarSummary([
        { dimensions: [], metrics: [120, 150, 400, 41.5, 73] },
      ]),
    ).toEqual({
      visitors: 120,
      sessions: 150,
      pageviews: 400,
      bounceRate: 41.5,
      visitDurationS: 73,
    });
    expect(
      oneDollarSummary([{ dimensions: [], metrics: [5, null, 9, null] }]),
    ).toEqual({
      visitors: 5,
      sessions: null,
      pageviews: 9,
      bounceRate: null,
      visitDurationS: null,
    });
  });

  test("an empty answer is a zero summary, not a failure", () => {
    expect(oneDollarSummary([])).toEqual({
      visitors: 0,
      sessions: null,
      pageviews: 0,
      bounceRate: null,
      visitDurationS: null,
    });
  });

  test("timeline sorts buckets and drops unlabeled rows", () => {
    expect(
      oneDollarTimeline([
        { dimensions: ["2026-03-01 10:00:00"], metrics: [3, 7] },
        { dimensions: [], metrics: [1, 1] },
        { dimensions: ["2026-03-01 09:00:00"], metrics: [2, null] },
      ]),
    ).toEqual([
      { t: "2026-03-01 09:00:00", visitors: 2, pageviews: 0 },
      { t: "2026-03-01 10:00:00", visitors: 3, pageviews: 7 },
    ]);
  });

  test("breakdown is busiest first and capped", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      dimensions: [`/p${i}`],
      metrics: [i],
    }));
    const out = oneDollarRows(rows);
    expect(out).toHaveLength(50);
    expect(out[0]).toEqual({ key: "/p59", count: 59 });
  });
});

describe("Deco Analytics normalizers", () => {
  test("summary maps the overview kpis and accepts numeric strings", () => {
    expect(
      decoSummary({
        kpis: [
          {
            visitors: 80,
            pageviews: "300",
            sessions: 95,
            bounce_pct: 38,
            duration_s: 61,
          },
        ],
      }),
    ).toEqual({
      visitors: 80,
      pageviews: 300,
      sessions: 95,
      bounceRate: 38,
      visitDurationS: 61,
    });
  });

  test("a payload without kpis is a zero summary with unknown extras", () => {
    expect(decoSummary({})).toEqual({
      visitors: 0,
      pageviews: 0,
      sessions: null,
      bounceRate: null,
      visitDurationS: null,
    });
  });

  test("a malformed kpi row does not throw", () => {
    expect(decoSummary({ kpis: [{ visitors: "many" }] }).visitors).toBe(0);
  });

  test("timeline keeps valid rows in time order", () => {
    expect(
      decoTimeline({
        series: [
          { t: "2026-03-01 10:00", visitors: 4, pageviews: 9 },
          { t: "2026-03-01 09:00", visitors: 2 },
          { visitors: 1 },
        ],
      }),
    ).toEqual([
      { t: "2026-03-01 09:00", visitors: 2, pageviews: 0 },
      { t: "2026-03-01 10:00", visitors: 4, pageviews: 9 },
    ]);
  });

  test("breakdown reads {k, n} rows busiest first and skips bad ones", () => {
    expect(
      decoBreakdown(
        {
          sources: [
            { k: "google", n: 10 },
            { k: "", n: 99 },
            { k: "direct", n: "25" },
            { k: "bad", n: "x" },
          ],
        },
        "sources",
      ),
    ).toEqual([
      { key: "direct", count: 25 },
      { key: "google", count: 10 },
    ]);
    expect(decoBreakdown({ sources: "nope" }, "sources")).toEqual([]);
  });
});
