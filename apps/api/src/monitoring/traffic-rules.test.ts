import { describe, expect, it } from "bun:test";
import { judgedHour } from "./traffic-lake";
import { evaluateTraffic, type TrafficDay } from "./traffic-rules";

const day = (visitors: number, pageviews = visitors * 3): TrafficDay => ({
  visitors: new Array<number>(24).fill(visitors),
  pageviews: new Array<number>(24).fill(pageviews),
});
const withHour = (d: TrafficDay, hour: number, v: number, p: number) => ({
  visitors: d.visitors.map((x, h) => (h === hour ? v : x)),
  pageviews: d.pageviews.map((x, h) => (h === hour ? p : x)),
});
const refs = [day(1000), day(1000), day(1000)];

describe("evaluateTraffic", () => {
  it("is ok on a usual hour", () => {
    const v = evaluateTraffic(day(1000), refs, 14);
    expect(v.visitors_drop).toMatchObject({ status: "ok", expected: 1000 });
    expect(v.pageviews_drop).toMatchObject({ status: "ok", expected: 3000 });
  });

  it("alerts on the measure that fell, not the one that held", () => {
    // Pageview tracking counting one view per visitor: visitors hold, pageviews fall to a third.
    const v = evaluateTraffic(withHour(day(1000), 14, 1000, 800), refs, 14);
    expect(v.visitors_drop.status).toBe("ok");
    expect(v.pageviews_drop).toMatchObject({ status: "alert", observed: 800 });
  });

  it("scales the baseline by how the day ran before the hour", () => {
    // A campaign day at twice the traffic: half of its own level is still a drop.
    const campaign = withHour(day(2000), 14, 500, 1500);
    const v = evaluateTraffic(campaign, refs, 14);
    expect(v.visitors_drop.level).toBe(2);
    expect(v.visitors_drop).toMatchObject({ status: "alert", expected: 2000 });
  });

  it("doesn't judge a quiet hour or a site with no history", () => {
    expect(evaluateTraffic(day(50), [day(50)], 14).visitors_drop.status).toBe(
      "low-volume",
    );
    expect(evaluateTraffic(day(0), [], 14).visitors_drop.status).toBe(
      "low-volume",
    );
  });

  it("alerts at the org's own thresholds", () => {
    const dip = withHour(day(1000), 14, 450, 1350);
    expect(evaluateTraffic(dip, refs, 14).visitors_drop.status).toBe("ok");
    expect(
      evaluateTraffic(dip, refs, 14, {
        visitors_drop: { threshold: 50, minVolume: 100 },
        pageviews_drop: { threshold: 30, minVolume: 300 },
      }).visitors_drop.status,
    ).toBe("alert");
  });
});

describe("judgedHour", () => {
  it("judges the last hour that ended at least 10 minutes ago, in the org's zone", () => {
    // 18:05 UTC: 17:00–18:00 ended only 5 minutes ago, so 16:00 UTC, 13:00 in São Paulo.
    expect(
      judgedHour(new Date("2026-11-18T18:05:00Z"), "America/Sao_Paulo"),
    ).toEqual({ hour: 13, hourStart: new Date("2026-11-18T16:00:00Z") });
    expect(judgedHour(new Date("2026-11-18T18:15:00Z"), "UTC").hour).toBe(17);
  });
});
