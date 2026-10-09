import { describe, expect, test } from "bun:test";
import {
  describeGaps,
  evidenceFrom,
  groundedOnly,
  pairReviews,
  unreviewed,
  withoutCollectionUrls,
} from "./campaign-suggest";

const target = (name: string, url: string, id = "") => ({
  kind: "category" as const,
  id,
  name,
  url,
  description: "",
});

const catalogued = (id: string, name: string) => ({
  id,
  name,
  category: "",
  price: "",
  slug: "",
  images: [],
  description: "",
  url: "",
});

describe("groundedOnly", () => {
  const raw = `
### ga4_report
{"landingPage":"https://loja.com/ar-condicionado"}

### catalog_search
{"productId":"148129","productName":"Split Inverter 12000","price":2199}
`;
  const catalogue = {
    products: [catalogued("148129", "Split Inverter 12000")],
    targets: [],
  };
  const evidence = evidenceFrom(catalogue, raw);

  test("keeps an item the catalogue holds, by id", () => {
    expect(groundedOnly([target("", "", "148129")], evidence)).toHaveLength(1);
  });

  test("keeps an item the catalogue holds, by name", () => {
    expect(
      groundedOnly([target("Split Inverter 12000", "")], evidence),
    ).toHaveLength(1);
  });

  test("keeps an item only the raw tool output mentions", () => {
    expect(
      groundedOnly([target("https://loja.com/ar-condicionado", "")], evidence),
    ).toHaveLength(1);
  });

  test("drops an item that appears in neither", () => {
    expect(
      groundedOnly(
        [target("Ventilador de teto", "https://loja.com/ventiladores")],
        evidence,
      ),
    ).toEqual([]);
  });

  test("matches case-insensitively, since the model retypes names", () => {
    expect(
      groundedOnly([target("SPLIT INVERTER 12000", "")], evidence),
    ).toHaveLength(1);
  });

  test("a name the prose paraphrased survives, because the raw output has it", () => {
    const proseOnly = evidenceFrom({ products: [], targets: [] }, raw);
    expect(
      groundedOnly([target("Split Inverter 12000", "")], proseOnly),
    ).toHaveLength(1);
  });

  test("drops everything when nothing was grounded at all", () => {
    const nothing = evidenceFrom({ products: [], targets: [] }, "");
    expect(groundedOnly([target("Qualquer coisa", "/x")], nothing)).toEqual([]);
  });

  test("an item with neither id nor name cannot be grounded", () => {
    expect(groundedOnly([target("", "")], evidence)).toEqual([]);
  });
});

describe("describeGaps", () => {
  const ok = {
    toolNames: ["catalog_search"],
    calls: [{}],
    outcome: "ok" as const,
  };
  const none = { targets: 0, products: 0 };

  test("a site with no connection gets its own code", () => {
    expect(
      describeGaps({ toolNames: [], calls: [], outcome: "no-site" }, "", none),
    ).toEqual([{ code: "no-site" }]);
  });

  test("a connection exposing nothing read-only says so, not 'no answer'", () => {
    expect(
      describeGaps({ toolNames: [], calls: [], outcome: "no-tools" }, "", none),
    ).toEqual([{ code: "no-tools" }]);
  });

  test("a timeout that got answers carries how many, never claims none", () => {
    expect(
      describeGaps(
        { toolNames: ["x"], calls: [{}, {}], outcome: "timeout" },
        "",
        none,
      ),
    ).toEqual([{ code: "timeout-partial", count: 2 }]);
  });

  test("a timeout before any answer is a different code", () => {
    expect(
      describeGaps(
        { toolNames: ["x"], calls: [], outcome: "timeout" },
        "",
        none,
      ),
    ).toEqual([{ code: "timeout-empty" }]);
  });

  test("distinguishes reachable-but-silent from absent", () => {
    expect(describeGaps(ok, "", none)).toEqual([{ code: "nothing-useful" }]);
  });

  test("reports what was dropped, with the count the UI words", () => {
    expect(describeGaps(ok, "something", { targets: 2, products: 1 })).toEqual([
      { code: "targets-dropped", count: 2 },
      { code: "products-dropped", count: 1 },
    ]);
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

describe("withoutCollectionUrls", () => {
  test("blanks the URL on a collection, which has no page of its own", () => {
    const [target] = withoutCollectionUrls([
      { kind: "collection", url: "https://loja.com/invented" },
    ]);
    expect(target?.url).toBe("");
  });

  test("leaves a category's URL alone", () => {
    const [target] = withoutCollectionUrls([
      { kind: "category", url: "https://loja.com/escolar" },
    ]);
    expect(target?.url).toBe("https://loja.com/escolar");
  });

  test("keeps every other field of the collection", () => {
    const [target] = withoutCollectionUrls([
      { kind: "collection", url: "https://x", id: "623", name: "Volta" },
    ]);
    expect(target).toEqual({
      kind: "collection",
      url: "",
      id: "623",
      name: "Volta",
    });
  });
});
