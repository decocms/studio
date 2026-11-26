import { describe, expect, test } from "bun:test";
import {
  advance,
  canApprove,
  lifecycleFromVerification,
  lifecycleOf,
  stopReasonOf,
  validationOf,
} from "./lifecycle.ts";
import type { CheckRun, HypothesisVerification } from "./verify/types.ts";

const run = (
  stage: "live" | "repo" | "data",
  outcome: CheckRun["outcome"],
  measures_cause?: boolean,
): CheckRun => ({
  check: { id: "c", stage } as never,
  outcome,
  observed: "",
  screenshot_url: null,
  source_ref: null,
  ...(measures_cause === undefined ? {} : { measures_cause }),
});

const v = (
  verdict: HypothesisVerification["verdict"],
  runs: CheckRun[],
): HypothesisVerification => ({
  verdict,
  summary: "s",
  runs,
  rewritten_from: null,
  verified_at: "2026-11-15T00:00:00Z",
});

describe("advance", () => {
  const start = { lifecycle: "gerada" as const, lifecycle_log: [] };

  test("follows the table and records the reason", () => {
    const a = advance(start, "em_investigacao", "começou", "t1");
    const b = a && advance(a, "condicao_confirmada", "c1 confirmou", "t2");
    expect(b?.lifecycle).toBe("condicao_confirmada");
    expect(b?.lifecycle_log.map((e) => e.state)).toEqual([
      "em_investigacao",
      "condicao_confirmada",
    ]);
  });

  test("a transition outside the table changes nothing", () => {
    expect(advance(start, "pronta_para_experimento", "pulo", "t")).toBeNull();
  });

  test("a refuted one can be investigated again", () => {
    const r = { lifecycle: "refutada" as const, lifecycle_log: [] };
    expect(
      advance(r, "em_investigacao", "verificar de novo", "t"),
    ).not.toBeNull();
  });
});

describe("lifecycleFromVerification", () => {
  test("verdict → state", () => {
    expect(
      lifecycleFromVerification(v("confirmada", [run("live", "confirma")])),
    ).toBe("condicao_confirmada");
    expect(
      lifecycleFromVerification(v("desmentida", [run("live", "desmente")])),
    ).toBe("refutada");
    expect(
      lifecycleFromVerification(
        v("inconclusiva", [run("live", "nao_decidiu")]),
      ),
    ).toBe("inconclusiva");
  });

  test("nothing ran is lack of access (blocked), not lack of evidence", () => {
    expect(lifecycleFromVerification(v("inconclusiva", []))).toBe("bloqueada");
    expect(
      lifecycleFromVerification(v("inconclusiva", [run("live", "nao_testou")])),
    ).toBe("bloqueada");
  });

  test("a rewrite confirmed on the second pass is a confirmed condition", () => {
    expect(
      lifecycleFromVerification(v("reescrita", [run("live", "confirma")])),
    ).toBe("condicao_confirmada");
    expect(lifecycleFromVerification(v("reescrita", []))).toBe("inconclusiva");
  });

  test("an old hypothesis without the column reads from the verdict; without a verdict it is generated", () => {
    expect(lifecycleOf({ verification: null })).toBe("gerada");
    expect(
      lifecycleOf({ verification: v("confirmada", [run("live", "confirma")]) }),
    ).toBe("condicao_confirmada");
    expect(lifecycleOf({ verification: null, lifecycle: "refutada" })).toBe(
      "refutada",
    );
  });
});

describe("validationOf", () => {
  test("live page = existence, code = implementation; a test outside the cause does not count", () => {
    const out = validationOf(
      v("confirmada", [
        run("live", "confirma"),
        run("repo", "desmente", false),
        run("repo", "nao_decidiu"),
      ]),
    );
    expect(out).toEqual({
      existencia: "confirmada",
      implementacao: "inconclusiva",
      relevancia: "nao_avaliada",
      causal: "nao_testado",
    });
  });

  test("confirming and disproving at the same level is a conflict; without verification, nothing tested", () => {
    expect(
      validationOf(
        v("inconclusiva", [run("live", "confirma"), run("live", "desmente")]),
      ).existencia,
    ).toBe("conflito");
    expect(validationOf(null).existencia).toBe("nao_testada");
  });
});

describe("stopReasonOf", () => {
  const h = (lifecycle: string, testable = true) =>
    ({
      verification: null,
      lifecycle,
      tree: { testavel_na_pagina: testable },
    }) as never;

  test("found a condition → candidate cause (the A/B is still missing)", () => {
    expect(
      stopReasonOf({}, [h("refutada"), h("condicao_confirmada")]).stop,
    ).toBe("achou_causa_candidata");
  });

  // Regression: a candidate cause must not show when the reviewer says the condition does not explain the loss.
  test("a confirmed condition the reviewer says does not explain the loss is not a candidate cause", () => {
    const reviewed = (explica: "sim" | "parcial" | "nao") =>
      ({
        verification: null,
        lifecycle: "relevancia_avaliada",
        tree: { testavel_na_pagina: true },
        review: { explica_o_gap: explica },
      }) as never;
    expect(stopReasonOf({}, [reviewed("nao")])).toMatchObject({
      stop: "evidencias_esgotadas",
      retired: false,
    });
    expect(stopReasonOf({}, [reviewed("nao")]).note).toContain("não explica");
    expect(stopReasonOf({}, [reviewed("nao"), reviewed("parcial")]).stop).toBe(
      "achou_causa_candidata",
    );
  });

  test("fragile data stops the investigation", () => {
    expect(
      stopReasonOf({ reliability: { level: "baixa", checks: [] } }, [
        h("inconclusiva"),
      ]).stop,
    ).toBe("dados_insuficientes");
  });

  test("testable left uninvestigated = budget; only inconclusive = exhausted", () => {
    expect(stopReasonOf({}, [h("refutada"), h("gerada")]).stop).toBe(
      "orcamento",
    );
    expect(stopReasonOf({}, [h("inconclusiva"), h("gerada", false)]).stop).toBe(
      "evidencias_esgotadas",
    );
    expect(stopReasonOf({}, [h("refutada")])).toMatchObject({
      stop: "todas_descartadas",
      retired: true,
    });
  });

  test("approving for the test requires a ready hypothesis", () => {
    expect(canApprove("gerada")).toBe(false);
    expect(canApprove("condicao_confirmada")).toBe(false);
    expect(canApprove("relevancia_avaliada")).toBe(false);
    expect(canApprove("pronta_para_experimento")).toBe(true);
  });
});
