import { describe, expect, test } from "bun:test";
import type {
  DiagnosisSummary,
  UxHypothesis,
  UxOpportunity,
} from "../types.ts";
import {
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
  test("oportunidade sem proposta e sem nota sai, com o motivo da verificação", () => {
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

  test("oportunidade com nota de erro nas hipóteses não sai", () => {
    const fallen = fallenAfterVerify([opp(1)], [], new Map(), {
      [`${D}:o1`]: "a chamada de hipóteses falhou",
    });
    expect(fallen).toEqual([]);
  });

  test("oportunidade com uma proposta de pé não sai", () => {
    const fallen = fallenAfterVerify(
      [opp(1)],
      [hyp(1, 2)],
      new Map([[`${D}:o1`, ["a hipótese 1 foi desmentida"]]]),
      {},
    );
    expect(fallen).toEqual([]);
  });

  test("'não faria' não segura a oportunidade", () => {
    const fallen = fallenAfterVerify(
      [opp(1)],
      [hyp(null, 1, "nao_faria")],
      new Map([[`${D}:o1`, ["desmentida"]]]),
      {},
    );
    expect(fallen.map((f) => f.id)).toEqual([`${D}:o1`]);
  });

  test("sem motivo gravado, ainda sai com um motivo legível", () => {
    const [f] = fallenAfterVerify([opp(1)], [], new Map(), {});
    expect(f?.reason.length).toBeGreaterThan(0);
  });
});

describe("hypothesisDeadline", () => {
  test("divide o que sobra do step entre as hipóteses que faltam", () => {
    // Step até 12_000; agora 2_000; 2 hipóteses: a primeira tem até 7_000.
    expect(hypothesisDeadline(12_000, 2_000, 2)).toBe(7_000);
    // A primeira terminou cedo (4_000): a segunda herda a sobra.
    expect(hypothesisDeadline(12_000, 4_000, 1)).toBe(12_000);
  });

  test("prazo do step já passou: o prazo é agora (nenhum teste começa)", () => {
    expect(hypothesisDeadline(10_000, 11_000, 2)).toBe(11_000);
  });

  test("zero hipóteses não divide por zero", () => {
    expect(hypothesisDeadline(10_000, 4_000, 0)).toBe(10_000);
  });
});

describe("rerunFailedPatch", () => {
  const summary = (): DiagnosisSummary => ({
    headline: "h",
    limits: ["antes"],
  });

  test("volta pra pronto e diz no limite que a verificação falhou", () => {
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
    // Não muta o summary lido.
    expect(s.limits).toEqual(["antes"]);
  });

  test("sem summary, não inventa um", () => {
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

  test("até 2 por oportunidade, as mais confiantes, sem as de fora da página, na ordem da tela", () => {
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

describe("fallenAfterVerify com o ciclo", () => {
  test("hipótese refutada não segura a oportunidade; aposentada não cai de novo", () => {
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
  test("a rodada encadeada fica onde sempre; o verificar de novo, sob a marca dele", () => {
    expect(verifyKeyPrefix("d1", undefined, "h1")).toBe("ux/d1/verify/h1");
    expect(verifyKeyPrefix("d1", "r2", "h1")).toBe("ux/d1/r2/verify/h1");
  });
});
