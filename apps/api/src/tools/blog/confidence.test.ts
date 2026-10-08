import { describe, expect, test } from "bun:test";
import {
  applyVerdicts,
  type Claim,
  type FieldSpec,
  flattenClaims,
  MIN_SCORE,
  renderClaims,
  type Verdict,
  verbatimExamples,
} from "./confidence";

const SPECS: readonly FieldSpec[] = [
  { field: "companyName", kind: "text", origin: "blocks" },
  { field: "values", kind: "rules", origin: "blocks" },
  { field: "keywords", kind: "terms", origin: "blocks" },
  { field: "voiceExamples", kind: "examples", origin: "blocks" },
  { field: "specialDates", kind: "rules", origin: "research" },
];

const pass = (id: number): Verdict => ({
  id,
  confidence: 95,
  relevance: 95,
  reason: "",
});

const fail = (id: number): Verdict => ({
  id,
  confidence: 20,
  relevance: 10,
  reason: "nothing in the evidence supports it",
});

/** Every claim cleared, so nothing is filtered. */
const allPass = (claims: readonly Claim[]) => claims.map((c) => pass(c.id));

describe("flattenClaims", () => {
  test("numbers claims from 1, across every field kind", () => {
    const claims = flattenClaims(
      {
        companyName: "Ateliê",
        values: [{ name: "Origem", value: "Tudo é feito aqui" }],
        keywords: ["linho crú"],
        voiceExamples: [{ text: "do rio pro mundo", sounds: true }],
        specialDates: [{ name: "Semana do Ateliê", value: "Em março" }],
      },
      SPECS,
    );
    expect(claims.map((c) => [c.id, c.field, c.text])).toEqual([
      [1, "companyName", "Ateliê"],
      [2, "values", "Origem: Tudo é feito aqui"],
      [3, "keywords", "linho crú"],
      [
        4,
        "voiceExamples",
        '"do rio pro mundo" — presented as how the brand sounds',
      ],
      [5, "specialDates", "Semana do Ateliê: Em março"],
    ]);
  });

  test("carries the counter-example flag, which is half the claim", () => {
    const claims = flattenClaims(
      { voiceExamples: [{ text: "Compre já!", sounds: false }] },
      [{ field: "voiceExamples", kind: "examples", origin: "blocks" }],
    );
    expect(claims[0]?.text).toBe(
      '"Compre já!" — presented as NOT how the brand sounds',
    );
  });

  test("a blank value is an editor row, not a claim, and is not numbered", () => {
    const claims = flattenClaims(
      {
        companyName: "   ",
        values: [
          { name: "", value: "" },
          { name: "Origem", value: "" },
        ],
        keywords: ["", "linho"],
      },
      SPECS,
    );
    expect(claims.map((c) => [c.id, c.text])).toEqual([
      [1, "Origem"],
      [2, "linho"],
    ]);
  });

  test("a field the model did not answer contributes nothing", () => {
    expect(flattenClaims({}, SPECS)).toEqual([]);
  });

  test("origin travels to the prompt, so the judge looks in the right place", () => {
    const claims = flattenClaims(
      {
        companyName: "Ateliê",
        specialDates: [{ name: "Natal", value: "Sim" }],
      },
      SPECS,
    );
    expect(renderClaims(claims)).toBe(
      "[1] companyName (from the site's own blocks): Ateliê\n" +
        "[2] specialDates (from web research): Natal: Sim",
    );
  });
});

describe("applyVerdicts", () => {
  const result = {
    companyName: "Ateliê",
    values: [
      { name: "Origem", value: "Tudo é feito aqui" },
      { name: "Qualidade", value: "Fazemos bem" },
    ],
    keywords: ["linho crú", "vestido de festa"],
    voiceExamples: [],
    specialDates: [],
  };
  const claims = flattenClaims(result, SPECS);

  test("drops only the claims that fell short, leaving the rest in place", () => {
    const gate = applyVerdicts(
      result,
      claims,
      claims.map((c) =>
        c.text.startsWith("Qualidade") ? fail(c.id) : pass(c.id),
      ),
      SPECS,
    );
    expect(gate.judged).toBe(true);
    expect(gate.kept.values).toEqual([
      { name: "Origem", value: "Tudo é feito aqui" },
    ]);
    expect(gate.kept.keywords).toEqual(["linho crú", "vestido de festa"]);
    expect(gate.discarded).toHaveLength(1);
    expect(gate.discarded[0]).toMatchObject({
      field: "values",
      confidence: 20,
      relevance: 10,
    });
  });

  test("a rejected scalar comes back blank rather than stale", () => {
    const gate = applyVerdicts(
      result,
      claims,
      claims.map((c) => (c.field === "companyName" ? fail(c.id) : pass(c.id))),
      SPECS,
    );
    expect(gate.kept.companyName).toBe("");
  });

  test("the bar is both axes, not their average", () => {
    const gate = applyVerdicts(
      result,
      claims,
      claims.map((c) =>
        c.field === "companyName"
          ? { id: c.id, confidence: 100, relevance: 30, reason: "generic" }
          : pass(c.id),
      ),
      SPECS,
    );
    expect(gate.kept.companyName).toBe("");
    expect(gate.discarded).toHaveLength(1);
  });

  test("exactly at the bar is kept — the threshold is inclusive", () => {
    const gate = applyVerdicts(
      result,
      claims,
      claims.map((c) => ({
        id: c.id,
        confidence: MIN_SCORE,
        relevance: MIN_SCORE,
        reason: "",
      })),
      SPECS,
    );
    expect(gate.discarded).toEqual([]);
    expect(gate.kept).toEqual(result);
  });

  test("one point under the bar is dropped", () => {
    const gate = applyVerdicts(
      result,
      claims,
      claims.map((c) =>
        c.field === "companyName"
          ? {
              id: c.id,
              confidence: MIN_SCORE - 1,
              relevance: 100,
              reason: "stretched",
            }
          : pass(c.id),
      ),
      SPECS,
    );
    expect(gate.kept.companyName).toBe("");
  });

  test("the order the model emitted its verdicts does not matter", () => {
    const verdicts = claims.map((c) =>
      c.text.startsWith("linho") ? fail(c.id) : pass(c.id),
    );
    const forward = applyVerdicts(result, claims, verdicts, SPECS);
    const reversed = applyVerdicts(
      result,
      claims,
      [...verdicts].reverse(),
      SPECS,
    );
    expect(reversed.kept).toEqual(forward.kept);
    expect(reversed.kept.keywords).toEqual(["vestido de festa"]);
  });

  test("a duplicated id keeps the lower score, so a second opinion can only reject", () => {
    const verdicts = [
      ...allPass(claims),
      { id: 1, confidence: 10, relevance: 95, reason: "not in the evidence" },
    ];
    const gate = applyVerdicts(result, claims, verdicts, SPECS);
    expect(gate.judged).toBe(true);
    expect(gate.kept.companyName).toBe("");
  });

  test("a verdict for an id never offered is ignored, not trusted", () => {
    const gate = applyVerdicts(
      result,
      claims,
      [...allPass(claims), fail(999), fail(0), fail(-1)],
      SPECS,
    );
    expect(gate.judged).toBe(true);
    expect(gate.discarded).toEqual([]);
    expect(gate.kept).toEqual(result);
  });

  test("partial coverage is a malformed answer: keep everything, say it was not judged", () => {
    const gate = applyVerdicts(
      result,
      claims,
      allPass(claims).slice(0, 2),
      SPECS,
    );
    expect(gate.judged).toBe(false);
    expect(gate.discarded).toEqual([]);
    expect(gate.kept).toEqual(result);
  });

  test("no judgement at all keeps everything rather than blanking the form", () => {
    const gate = applyVerdicts(result, claims, null, SPECS);
    expect(gate.judged).toBe(false);
    expect(gate.kept).toEqual(result);
  });

  test("a blank editor row is carried through, never silently tidied away", () => {
    const withBlank = {
      ...result,
      values: [...result.values, { name: "", value: "" }],
    };
    const blankClaims = flattenClaims(withBlank, SPECS);
    const gate = applyVerdicts(
      withBlank,
      blankClaims,
      blankClaims.map((c) =>
        c.text.startsWith("Qualidade") ? fail(c.id) : pass(c.id),
      ),
      SPECS,
    );
    expect(gate.kept.values).toEqual([
      { name: "Origem", value: "Tudo é feito aqui" },
      { name: "", value: "" },
    ]);
  });

  test("every claim rejected empties the profile, which is the point", () => {
    const gate = applyVerdicts(
      result,
      claims,
      claims.map((c) => fail(c.id)),
      SPECS,
    );
    expect(gate.judged).toBe(true);
    expect(gate.discarded).toHaveLength(claims.length);
    expect(gate.kept).toEqual({
      companyName: "",
      values: [],
      keywords: [],
      voiceExamples: [],
      specialDates: [],
    });
  });

  test("nothing to judge is judged, not skipped", () => {
    const gate = applyVerdicts({}, [], [], SPECS);
    expect(gate.judged).toBe(true);
    expect(gate.discarded).toEqual([]);
  });
});

describe("verbatimExamples", () => {
  const evidence = "## Block: home\n\nDo rio pro mundo, desde 1998.";

  test("keeps a quote that is actually on the page", () => {
    expect(
      verbatimExamples([{ text: "Do rio pro mundo", sounds: true }], evidence),
    ).toHaveLength(1);
  });

  test("drops a quote the model improved, however slightly", () => {
    expect(
      verbatimExamples(
        [{ text: "Do rio para o mundo", sounds: true }],
        evidence,
      ),
    ).toEqual([]);
  });

  test("whitespace is collapsed on both sides, so stored indentation is not a mismatch", () => {
    expect(
      verbatimExamples(
        [{ text: "Do rio\n   pro   mundo", sounds: true }],
        evidence,
      ),
    ).toHaveLength(1);
  });

  test("a blank or non-string quote never counts as present", () => {
    expect(
      verbatimExamples(
        [{ text: "  " }, { text: undefined }, { text: 7 }],
        evidence,
      ),
    ).toEqual([]);
  });
});
