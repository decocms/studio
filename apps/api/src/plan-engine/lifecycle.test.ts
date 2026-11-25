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

  test("anda pela tabela e registra o motivo", () => {
    const a = advance(start, "em_investigacao", "começou", "t1");
    const b = a && advance(a, "condicao_confirmada", "c1 confirmou", "t2");
    expect(b?.lifecycle).toBe("condicao_confirmada");
    expect(b?.lifecycle_log.map((e) => e.state)).toEqual([
      "em_investigacao",
      "condicao_confirmada",
    ]);
  });

  test("transição fora da tabela não muda nada", () => {
    expect(advance(start, "pronta_para_experimento", "pulo", "t")).toBeNull();
  });

  test("refutada pode voltar a ser investigada", () => {
    const r = { lifecycle: "refutada" as const, lifecycle_log: [] };
    expect(
      advance(r, "em_investigacao", "verificar de novo", "t"),
    ).not.toBeNull();
  });
});

describe("lifecycleFromVerification", () => {
  test("veredito → estado", () => {
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

  test("nada rodou é falta de acesso (bloqueada), não falta de evidência", () => {
    expect(lifecycleFromVerification(v("inconclusiva", []))).toBe("bloqueada");
    expect(
      lifecycleFromVerification(v("inconclusiva", [run("live", "nao_testou")])),
    ).toBe("bloqueada");
  });

  test("reescrita que se confirmou na segunda volta é condição confirmada", () => {
    expect(
      lifecycleFromVerification(v("reescrita", [run("live", "confirma")])),
    ).toBe("condicao_confirmada");
    expect(lifecycleFromVerification(v("reescrita", []))).toBe("inconclusiva");
  });

  test("hipótese antiga sem coluna lê do veredito; sem veredito é gerada", () => {
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
  test("página no ar = existência, código = implementação; teste fora da causa não conta", () => {
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

  test("confirma e desmente no mesmo nível é conflito; sem verificação, nada testado", () => {
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

  test("achou condição → causa candidata (ainda falta o A/B)", () => {
    expect(
      stopReasonOf({}, [h("refutada"), h("condicao_confirmada")]).stop,
    ).toBe("achou_causa_candidata");
  });

  // 16/11 (categoria de uma loja de moda): a tela disse "achamos uma causa candidata" com
  // o revisor respondendo que a condição não explica a perda.
  test("condição confirmada que o revisor diz não explicar a perda não é causa candidata", () => {
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

  test("dados frágeis param a investigação", () => {
    expect(
      stopReasonOf({ reliability: { level: "baixa", checks: [] } }, [
        h("inconclusiva"),
      ]).stop,
    ).toBe("dados_insuficientes");
  });

  test("sobrou testável sem investigar = orçamento; só inconclusivas = esgotadas", () => {
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

  test("aprovar pro teste exige a hipótese pronta", () => {
    expect(canApprove("gerada")).toBe(false);
    expect(canApprove("condicao_confirmada")).toBe(false);
    expect(canApprove("relevancia_avaliada")).toBe(false);
    expect(canApprove("pronta_para_experimento")).toBe(true);
  });
});
