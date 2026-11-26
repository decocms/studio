import { describe, expect, test } from "bun:test";
import { evidence } from "../fixtures/evidence.ts";
import { NO_AI_MODEL, noAiModelGap } from "../ports.ts";
import type {
  DiagnosisSummary,
  UxHypothesis,
  UxOpportunity,
} from "../types.ts";
import {
  failPatch,
  fallenAfterVerify,
  hypothesisDeadline,
  rerunFailedPatch,
  toInvestigate,
  verifyKeyPrefix,
} from "./verify-steps.ts";

const D = "d1";

function opp(rank: number, title = `oportunidade ${rank}`): UxOpportunity {
  return {
    id: `${D}:o${rank}`,
    diagnosis_id: D,
    rank,
    area: "titulo_preco",
    title,
    summary: "",
    device: "mobile",
    sources: [],
    money: null,
    confidence: 0.5,
    updated_at: "2026-11-13T00:00:00Z",
  };
}

function hyp(
  opportunityRank: number | null,
  rank: number,
  kind: UxHypothesis["kind"] = "proposta",
): UxHypothesis {
  return {
    id: `${D}:o${opportunityRank}:h${rank}`,
    diagnosis_id: D,
    opportunity_id:
      opportunityRank === null ? null : `${D}:o${opportunityRank}`,
    rank,
    kind,
    title: `hipótese ${rank}`,
  } as UxHypothesis;
}

describe("fallenAfterVerify", () => {
  test("an opportunity with no proposal and no note falls, with the verification's reason", () => {
    const fallen = fallenAfterVerify(
      [opp(1, "Preço escondido"), opp(2)],
      [hyp(2, 1)],
      new Map([
        [`${D}:o1`, ["o preço está acima da dobra", "o título não é link"]],
      ]),
      {},
    );
    expect(fallen).toEqual([
      {
        id: `${D}:o1`,
        rank: 1,
        title: "Preço escondido",
        reason: "o preço está acima da dobra; o título não é link",
      },
    ]);
  });

  test("an opportunity with a hypothesis error note does not fall", () => {
    const fallen = fallenAfterVerify([opp(1)], [], new Map(), {
      [`${D}:o1`]: "a chamada de hipóteses falhou",
    });
    expect(fallen).toEqual([]);
  });

  test("an opportunity with a standing proposal does not fall", () => {
    const fallen = fallenAfterVerify(
      [opp(1)],
      [hyp(1, 2)],
      new Map([[`${D}:o1`, ["a hipótese 1 foi desmentida"]]]),
      {},
    );
    expect(fallen).toEqual([]);
  });

  test("'nao_faria' does not hold the opportunity up", () => {
    const fallen = fallenAfterVerify(
      [opp(1)],
      [hyp(null, 1, "nao_faria")],
      new Map([[`${D}:o1`, ["desmentida"]]]),
      {},
    );
    expect(fallen.map((f) => f.id)).toEqual([`${D}:o1`]);
  });

  test("with no stored reason, still falls with a readable reason", () => {
    const [f] = fallenAfterVerify([opp(1)], [], new Map(), {});
    expect(f?.reason.length).toBeGreaterThan(0);
  });
});

describe("hypothesisDeadline", () => {
  test("splits what is left of the step among the remaining hypotheses", () => {
    // Step until 12_000; now 2_000; 2 hypotheses: the first gets until 7_000.
    expect(hypothesisDeadline(12_000, 2_000, 2)).toBe(7_000);
    // The first finished early (4_000): the second inherits the rest.
    expect(hypothesisDeadline(12_000, 4_000, 1)).toBe(12_000);
  });

  test("step deadline already passed: the deadline is now (no test starts)", () => {
    expect(hypothesisDeadline(10_000, 11_000, 2)).toBe(11_000);
  });

  test("zero hypotheses does not divide by zero", () => {
    expect(hypothesisDeadline(10_000, 4_000, 0)).toBe(10_000);
  });
});

describe("rerunFailedPatch", () => {
  const summary = (): DiagnosisSummary => ({
    headline: "h",
    limits: ["antes"],
  });

  test("goes back to done and says in the limits that verification failed", () => {
    const s = summary();
    const patch = rerunFailedPatch(s, "boom");
    expect(patch.status).toBe("done");
    expect(patch.stage).toBe("done");
    expect(patch.progress_note).toBeNull();
    expect(patch.finished).toBe(true);
    expect(patch.error).toBeUndefined();
    expect(patch.summary?.limits).toEqual([
      "antes",
      "A verificação de novo falhou: boom",
    ]);
    // Does not mutate the summary it read.
    expect(s.limits).toEqual(["antes"]);
  });

  test("without a summary, does not invent one", () => {
    expect(rerunFailedPatch(null, "boom").summary).toBeUndefined();
  });
});

describe("toInvestigate", () => {
  const h = (id: string, opp: string, confidence: number, testable = true) =>
    ({
      id,
      opportunity_id: opp,
      rank: Number(id.slice(-1)),
      confidence,
      tree: { testavel_na_pagina: testable },
    }) as never;

  test("up to 2 per opportunity, most confident first, skipping off-page ones, in screen order", () => {
    const list = [
      h("o1:h1", "o1", 0.5),
      h("o1:h2", "o1", 0.8),
      h("o1:h3", "o1", 0.9, false),
      h("o1:h4", "o1", 0.6),
      h("o2:h1", "o2", 0.3),
    ];
    expect(toInvestigate(list).map((x: { id: string }) => x.id)).toEqual([
      "o1:h2",
      "o1:h4",
      "o2:h1",
    ]);
  });
});

describe("fallenAfterVerify with the lifecycle", () => {
  test("a refuted hypothesis does not hold the opportunity up; a retired one does not fall again", () => {
    const refuted = { ...hyp(1, 1), lifecycle: "refutada" as const };
    const retired = {
      ...opp(2),
      outcome: { stop: "todas_descartadas" as const, retired: true, note: "" },
    };
    const fallen = fallenAfterVerify(
      [opp(1), retired],
      [refuted],
      new Map(),
      {},
    );
    expect(fallen.map((f) => f.id)).toEqual([`${D}:o1`]);
  });
});

describe("verifyKeyPrefix", () => {
  test("the chained round keeps the usual prefix; verify again goes under its tag", () => {
    expect(verifyKeyPrefix("d1", undefined, "h1")).toBe("ux/d1/verify/h1");
    expect(verifyKeyPrefix("d1", "r2", "h1")).toBe("ux/d1/r2/verify/h1");
  });
});

describe("failPatch", () => {
  test("a lost model ends the run with its message and the customer's gap", () => {
    const patch = failPatch(
      { evidence: evidence(), summary: null },
      false,
      NO_AI_MODEL,
    );
    expect(patch).toMatchObject({
      status: "error",
      error: NO_AI_MODEL,
      finished: true,
    });
    expect(patch.evidence?.gaps).toContainEqual(noAiModelGap());
  });

  test("a lost model on verify again keeps the result and adds the gap once", () => {
    const patch = failPatch(
      {
        evidence: evidence({ gaps: [noAiModelGap()] }),
        summary: { headline: "h", limits: [] },
      },
      true,
      NO_AI_MODEL,
    );
    expect(patch.status).toBe("done");
    expect(patch.summary?.limits).toEqual([
      `A verificação de novo falhou: ${NO_AI_MODEL}`,
    ]);
    expect(
      patch.evidence?.gaps.filter((g) => g.key === "ai_provider"),
    ).toHaveLength(1);
  });

  test("any other failure leaves the evidence alone", () => {
    expect(
      failPatch({ evidence: evidence(), summary: null }, false, "boom"),
    ).toEqual({ status: "error", error: "boom", finished: true });
  });
});
