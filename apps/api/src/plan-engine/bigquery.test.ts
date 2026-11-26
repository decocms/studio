import { describe, expect, test } from "bun:test";
import { buildPdpViewsQuery, fetchPdpViews, scanCostUsd } from "./bigquery.ts";

describe("scanCostUsd", () => {
  test("prices a TiB at the on-demand rate", () => {
    expect(scanCostUsd(1024 ** 4)).toBeCloseTo(6.25, 6);
    expect(scanCostUsd(0)).toBe(0);
  });

  test("bytes never reported stay unknown, not free", () => {
    expect(scanCostUsd(null)).toBeNull();
  });
});

describe("fetchPdpViews", () => {
  test("pages through the result and reports each scan", async () => {
    const args: Array<Record<string, unknown>> = [];
    const scans: Array<number | null> = [];
    const out = await fetchPdpViews(
      async (a) => {
        args.push(a);
        return a.pageToken
          ? { rows: [{ product_id: "2", views: "5" }] }
          : {
              rows: [
                { product_id: "1", views: "9" },
                { product_id: "not-a-product", views: "3" },
              ],
              nextPageToken: "t2",
              totalBytesBilled: "1024",
            };
      },
      "proj",
      "analytics_1",
      { onScan: (s) => scans.push(s.bytesBilled) },
    );
    expect(out).toEqual([
      { product_id: "1", views: 9 },
      { product_id: "2", views: 5 },
    ]);
    expect(args[0]?.query).toContain("`proj.analytics_1.events_*`");
    expect(args[1]).toEqual({
      projectId: "proj",
      pageToken: "t2",
      maxResults: 5000,
    });
    expect(scans).toEqual([1024, null]);
  });

  test("refuses an identifier that would reach the SQL", () => {
    expect(() => buildPdpViewsQuery("p; DROP", "d", 7)).toThrow();
  });
});
