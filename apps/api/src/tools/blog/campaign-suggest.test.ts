import { describe, expect, test } from "bun:test";
import {
  describeGaps,
  groundedOnly,
  pairReviews,
  unreviewed,
} from "./campaign-suggest";

const target = (name: string, url: string) => ({
  kind: "category" as const,
  id: "",
  name,
  url,
  description: "",
});

describe("groundedOnly", () => {
  const grounding = `
GA4 reports the top landing page is https://loja.com/ar-condicionado.
The catalogue lists "Split Inverter 12000" at R$ 2.199.
`;

  test("keeps an item the store actually reported, by name or by url", () => {
    const kept = groundedOnly(
      [
        target("Split Inverter 12000", ""),
        target("", "https://loja.com/ar-condicionado"),
      ],
      grounding,
    );
    expect(kept).toHaveLength(2);
  });

  test("drops an item that appears nowhere in the grounding", () => {
    const kept = groundedOnly(
      [target("Ventilador de teto", "https://loja.com/ventiladores")],
      grounding,
    );
    expect(kept).toEqual([]);
  });

  test("matches case-insensitively, since the model retypes names", () => {
    expect(
      groundedOnly([target("SPLIT INVERTER 12000", "")], grounding),
    ).toHaveLength(1);
  });

  test("drops everything when nothing was grounded", () => {
    expect(groundedOnly([target("Qualquer coisa", "/x")], "")).toEqual([]);
    expect(groundedOnly([target("Qualquer coisa", "/x")], "   ")).toEqual([]);
  });

  test("an item with neither name nor url cannot be grounded", () => {
    expect(groundedOnly([target("", "")], grounding)).toEqual([]);
  });
});

describe("describeGaps", () => {
  const ok = {
    toolNames: ["catalog_search"],
    calls: [{}],
    outcome: "ok" as const,
  };
  const none = { targets: 0, products: 0 };

  test("a site with no connection is told to connect one", () => {
    const gaps = describeGaps(
      { toolNames: [], calls: [], outcome: "no-site" },
      "",
      none,
    );
    expect(gaps[0]).toContain("no connections to read");
  });

  test("a connection exposing nothing read-only says so, not 'no answer'", () => {
    const gaps = describeGaps(
      { toolNames: [], calls: [], outcome: "no-tools" },
      "",
      none,
    );
    expect(gaps[0]).toContain("no read-only tools");
  });

  test("a timeout that got answers never claims nothing answered", () => {
    const gaps = describeGaps(
      { toolNames: ["x"], calls: [{}, {}], outcome: "timeout" },
      "",
      none,
    );
    expect(gaps[0]).toContain("2 call(s) came back");
    expect(gaps[0]).not.toContain("no connections");
  });

  test("a timeout before any answer says that instead", () => {
    const gaps = describeGaps(
      { toolNames: ["x"], calls: [], outcome: "timeout" },
      "",
      none,
    );
    expect(gaps[0]).toContain("ran out of time before anything came back");
  });

  test("distinguishes reachable-but-silent from absent", () => {
    const gaps = describeGaps(ok, "", none);
    expect(gaps[0]).toContain("reported nothing useful");
  });

  test("reports what was dropped for lack of backing", () => {
    const gaps = describeGaps(ok, "something", { targets: 2, products: 1 });
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toContain("2 proposed target(s)");
    expect(gaps[1]).toContain("1 proposed product(s)");
  });

  test("is silent when the pass worked and nothing was dropped", () => {
    expect(describeGaps(ok, "something", none)).toEqual([]);
  });
});

describe("pairReviews", () => {
  const candidates = [{ name: "A" }, { name: "B" }];
  const review = (index: number, verdict: "strong" | "weak") => ({
    index,
    verdict,
    rationale: `r${index}`,
    risks: [],
  });

  test("pairs by 1-based index", () => {
    const paired = pairReviews(candidates, [
      review(2, "weak"),
      review(1, "strong"),
    ]);
    expect(paired[0]?.review.verdict).toBe("strong");
    expect(paired[1]?.review.verdict).toBe("weak");
  });

  test("ignores an out-of-range index rather than shifting the rest", () => {
    const paired = pairReviews(candidates, [
      review(7, "weak"),
      review(1, "strong"),
    ]);
    expect(paired[0]?.review.verdict).toBe("strong");
    expect(paired[1]?.review.verdict).toBe("workable");
    expect(paired[1]?.review.rationale).toBe("");
  });

  test("keeps the first of a duplicated index", () => {
    const paired = pairReviews(candidates, [
      review(1, "strong"),
      review(1, "weak"),
    ]);
    expect(paired[0]?.review.verdict).toBe("strong");
  });

  test("a missing review reads as workable, not as a verdict", () => {
    const paired = pairReviews(candidates, []);
    expect(paired.map((c) => c.review.verdict)).toEqual([
      "workable",
      "workable",
    ]);
  });

  test("carries the candidate through untouched", () => {
    expect(pairReviews(candidates, [])[0]?.name).toBe("A");
  });
});

describe("unreviewed", () => {
  test("stands in for every candidate when the reviewer fails", () => {
    const stand = unreviewed(3);
    expect(stand.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(stand.every((r) => r.verdict === "workable")).toBe(true);
  });
});
