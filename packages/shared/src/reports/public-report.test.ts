import { describe, expect, test } from "bun:test";
import { OnePagerSchema } from "./public-report";

const REPORT = {
  domain: "example.com",
  brand: "Example",
  scanned_at: "2026-09-20T12:00:00.000Z",
  lang: "pt",
  score: 62,
  band: "Regular",
  totals: {
    measured: 10,
    registry_total: 20,
    passed: 7,
    failed: 3,
    blocked: 2,
  },
  buckets: [
    {
      id: "critical",
      label: "Crítico — resolver agora",
      items: [
        {
          check_id: "PERF-001",
          title: "LCP dentro do alvo",
          domain: "PERF",
          category: "Performance",
          severity: "error",
          pages: ["Home"],
          tasks: [],
          evidence: "LCP 4.1s",
          sources: [],
        },
      ],
    },
  ],
  passing: { count: 0, items: [] },
  not_measured: { count: 0, groups: [] },
  categories: [],
  screenshots: [],
};

describe("OnePagerSchema", () => {
  test("accepts the engine's one-pager and drops fields the page does not read", () => {
    const parsed = OnePagerSchema.parse({ ...REPORT, url: "ignored" });
    expect(parsed.buckets[0]?.items[0]?.check_id).toBe("PERF-001");
    expect("url" in parsed).toBe(false);
  });

  test("accepts a report the engine has not scored yet", () => {
    const parsed = OnePagerSchema.parse({
      ...REPORT,
      scanned_at: null,
      score: null,
      band: null,
      buckets: [],
    });
    expect(parsed.score).toBeNull();
  });

  test("rejects a bucket the page has no heading for", () => {
    const result = OnePagerSchema.safeParse({
      ...REPORT,
      buckets: [{ ...REPORT.buckets[0], id: "passing" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects a finding without its evidence", () => {
    const { evidence: _, ...item } = REPORT.buckets[0]!.items[0]!;
    const result = OnePagerSchema.safeParse({
      ...REPORT,
      buckets: [{ ...REPORT.buckets[0], items: [item] }],
    });
    expect(result.success).toBe(false);
  });
});
