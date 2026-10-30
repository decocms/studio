import { describe, expect, test } from "bun:test";
import { assess, bandCounts, bandOf } from "./vitals-model";

describe("bandOf", () => {
  test("thresholds are inclusive of good and poor edges", () => {
    expect(bandOf("lcp", 2500)).toBe("good");
    expect(bandOf("lcp", 2501)).toBe("needs work");
    expect(bandOf("lcp", 4001)).toBe("poor");
    expect(bandOf("cls", 0.1)).toBe("good");
  });
  test("no measurement is no band", () => {
    expect(bandOf("inp", null)).toBeNull();
    expect(bandOf("inp", Number.NaN)).toBeNull();
  });
});

describe("assess", () => {
  const all = { lcp: 2000, inp: 150, cls: 0.05, ttfb: 3000, fcp: 4000 };
  test("passes only on the three core metrics", () => {
    expect(assess(all).verdict).toBe("passing");
  });
  test("one core metric outside good fails", () => {
    expect(assess({ ...all, inp: 340 }).verdict).toBe("failing");
  });
  test("a core metric with no samples is incomplete, not passing", () => {
    const r = assess({ ...all, inp: null });
    expect(r.verdict).toBe("incomplete");
    expect(r.missing).toEqual(["inp"]);
  });
});

describe("bandCounts", () => {
  test("adds rows and ignores unknown metrics or bands", () => {
    const c = bandCounts([
      { metric: "lcp", band: "good", n: 3 },
      { metric: "lcp", band: "good", n: "2" },
      { metric: "lcp", band: "", n: 9 },
      { metric: "fid", band: "good", n: 9 },
    ]);
    expect(c.lcp.good).toBe(5);
    expect(c.lcp.poor).toBe(0);
  });
});
