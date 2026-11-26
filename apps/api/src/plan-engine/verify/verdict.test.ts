import { describe, expect, test } from "bun:test";
import type { CheckOutcome, CheckRun } from "./types.ts";
import { JUDGE_SYSTEM, parseJudgment, scrollForPrompt } from "./verdict.ts";

function run(
  id: string,
  outcome: CheckOutcome,
  source_ref: string | null = null,
): CheckRun {
  return {
    check: {
      id,
      claim: `claim ${id}`,
      stage: "live",
      device: "mobile",
      steps: [],
      question: null,
      confirms_if: "a",
      refutes_if: "b",
    },
    outcome,
    observed: "viu algo",
    screenshot_url: null,
    source_ref,
  };
}
const rewrite = {
  title: "t",
  why: "w",
  prediction: "p",
  evidence_md: "e",
  idea: "i",
  where: "x",
};
const raw = (o: unknown) => JSON.stringify(o);

describe("parseJudgment", () => {
  test("todos nao_testou vira inconclusiva", () => {
    const r = parseJudgment(
      raw({
        verdict: "confirmada",
        summary: "s",
        runs: [{ id: "c1", outcome: "confirma" }],
      }),
      [run("c1", "nao_testou")],
      true,
    );
    expect(r.verdict).toBe("inconclusiva");
    expect(r.runs[0]?.outcome).toBe("nao_testou");
  });

  // 14/11: conflito (c1 confirma, c2 desmente uma versão mais forte) não derruba nem confirma.
  test("confirma + desmente é conflito: inconclusiva, cita os dois, sem reescrita", () => {
    const r = parseJudgment(
      raw({
        verdict: "confirmada",
        summary: "",
        runs: [
          { id: "c1", outcome: "confirma" },
          { id: "c2", outcome: "desmente" },
        ],
      }),
      [run("c1", "nao_decidiu"), run("c2", "nao_decidiu")],
      true,
    );
    expect(r.verdict).toBe("inconclusiva");
    expect(r.summary).toContain("c1");
    expect(r.summary).toContain("c2");
    expect(r.rewrite).toBeNull();
  });

  test("conflito com o modelo pedindo reescrita também fica inconclusiva", () => {
    const r = parseJudgment(
      raw({
        verdict: "reescrita",
        summary: "s",
        runs: [
          { id: "c1", outcome: "confirma" },
          { id: "c2", outcome: "desmente" },
        ],
        rewrite,
      }),
      [run("c1", "nao_decidiu"), run("c2", "nao_decidiu")],
      true,
    );
    expect(r.verdict).toBe("inconclusiva");
    expect(r.rewrite).toBeNull();
  });

  test("desmente com rewrite completo vira reescrita", () => {
    const r = parseJudgment(
      raw({
        verdict: "reescrita",
        summary: "s",
        runs: [{ id: "c1", outcome: "desmente" }],
        rewrite,
      }),
      [run("c1", "nao_decidiu")],
      true,
    );
    expect(r.verdict).toBe("reescrita");
    expect(r.rewrite).toEqual(rewrite);
  });

  test("rewrite com campo vazio vira desmentida", () => {
    const r = parseJudgment(
      raw({
        verdict: "reescrita",
        summary: "s",
        runs: [{ id: "c1", outcome: "desmente" }],
        rewrite: { ...rewrite, idea: "" },
      }),
      [run("c1", "nao_decidiu")],
      true,
    );
    expect(r.verdict).toBe("desmentida");
    expect(r.rewrite).toBeNull();
  });

  test("allowRewrite false vira desmentida", () => {
    const r = parseJudgment(
      raw({
        verdict: "reescrita",
        summary: "s",
        runs: [{ id: "c1", outcome: "desmente" }],
        rewrite,
      }),
      [run("c1", "nao_decidiu")],
      false,
    );
    expect(r.verdict).toBe("desmentida");
    expect(r.rewrite).toBeNull();
  });

  test("modelo não muda nao_testou nem run de repo já decidido", () => {
    const r = parseJudgment(
      raw({
        verdict: "confirmada",
        summary: "s",
        runs: [
          { id: "c1", outcome: "confirma" },
          { id: "c2", outcome: "desmente" },
          { id: "zz", outcome: "confirma" },
        ],
      }),
      [run("c1", "nao_testou"), run("c2", "confirma", "a.tsx:1")],
      true,
    );
    expect(r.runs.map((x) => x.outcome)).toEqual(["nao_testou", "confirma"]);
    expect(r.verdict).toBe("confirmada");
  });

  test("saída ilegível vira inconclusiva sem lançar", () => {
    const runs = [run("c1", "nao_decidiu")];
    const r = parseJudgment("blá", runs, true);
    expect(r.verdict).toBe("inconclusiva");
    expect(r.summary).toStartWith("a verificação não decidiu:");
    expect(r.runs).toEqual(runs);
  });

  test("resumo do modelo que contradiz o veredito do código é descartado", () => {
    const r = parseJudgment(
      raw({
        verdict: "confirmada",
        summary: "A causa se sustenta",
        runs: [{ id: "c1", outcome: "desmente" }],
      }),
      [run("c1", "nao_decidiu")],
      true,
    );
    expect(r.verdict).toBe("desmentida");
    expect(r.summary).not.toContain("se sustenta");
    expect(r.summary).toContain("c1");
  });

  test("objeto que não é objeto não lança", () => {
    for (const bad of ["null", "[]", "[1]"]) {
      const r = parseJudgment(bad, [run("c1", "nao_decidiu")], true);
      expect(r.verdict).toBe("inconclusiva");
      expect(r.summary).toStartWith("a verificação não decidiu:");
    }
  });

  test("modelo diz confirmada mas nenhum run decidido vira inconclusiva", () => {
    const r = parseJudgment(
      raw({
        verdict: "confirmada",
        summary: "Confirmada",
        runs: [{ id: "c1", outcome: "nao_decidiu" }],
      }),
      [run("c1", "nao_decidiu")],
      true,
    );
    expect(r.verdict).toBe("inconclusiva");
    expect(r.summary).not.toBe("Confirmada");
  });

  test("só confirma e modelo diz reescrita vira confirmada sem rewrite", () => {
    const r = parseJudgment(
      raw({
        verdict: "reescrita",
        summary: "reescreva",
        runs: [{ id: "c1", outcome: "confirma" }],
        rewrite,
      }),
      [run("c1", "nao_decidiu")],
      true,
    );
    expect(r.verdict).toBe("confirmada");
    expect(r.rewrite).toBeNull();
    expect(r.summary).not.toBe("reescreva");
  });
});

// 14/11: o juiz recebe a rolagem medida e a altura da página, não um px solto.
describe("scrollForPrompt", () => {
  test("junta alcance por dispositivo com a altura da página capturada", () => {
    const text = scrollForPrompt({
      pdp_behaviour: [
        {
          device: "mobile",
          avg_fold_pct: 18.5,
          avg_depth_pct: 41,
          reach: { p25: 62, p50: 29, p75: 12 },
        },
      ],
      captures: [{ device: "mobile", page_height: 4721 }],
    });
    expect(text).toContain("62% / 29% / 12%");
    expect(text).toContain("altura da página capturada: 4721px");
  });

  test("sem captura do dispositivo, não inventa altura", () => {
    const text = scrollForPrompt({
      pdp_behaviour: [
        {
          device: "desktop",
          avg_fold_pct: 25.9,
          avg_depth_pct: 50,
          reach: { p25: 70, p50: 40, p75: 20 },
        },
      ],
      captures: [],
    });
    expect(text).not.toContain("altura");
  });
});

// 14/11: dobra se decide com a altura da tela, fundo com o alcance.
describe("régua de posição do juiz", () => {
  test("o juiz recebe a altura da tela como dobra", () => {
    const text = scrollForPrompt({
      pdp_behaviour: [
        {
          device: "mobile",
          avg_fold_pct: 18.5,
          avg_depth_pct: 41,
          reach: { p25: 62, p50: 29, p75: 12 },
        },
      ],
      captures: [
        {
          device: "mobile",
          page_height: 4721,
          viewport: { width: 390, height: 844 },
        },
      ],
    });
    expect(text).toContain("altura da tela (a dobra): 844px");
  });

  test("captura sem rolagem do aparelho ainda dá a altura da tela", () => {
    const text = scrollForPrompt({
      pdp_behaviour: [],
      captures: [
        {
          device: "desktop",
          page_height: 3000,
          viewport: { width: 1366, height: 768 },
        },
      ],
    });
    expect(text).toContain("desktop: sem dados de rolagem");
    expect(text).toContain("altura da tela (a dobra): 768px");
  });

  test("a regra separa dobra de alcance", () => {
    expect(JUDGE_SYSTEM).toContain("ALTURA DA TELA");
    expect(JUDGE_SYSTEM).toContain(
      "Um teste de alcance não decide uma hipótese de dobra",
    );
  });
});

// 14/11: o código desmentiu a causa e um teste do sintoma "confirmou".
describe("teste que não mede a causa", () => {
  test("sai dos dois lados: o que mede a causa decide", () => {
    const r = parseJudgment(
      raw({
        verdict: "desmentida",
        summary: "",
        runs: [
          { id: "c1", outcome: "desmente" },
          { id: "c2", outcome: "confirma", measures_cause: false },
        ],
      }),
      [run("c1", "nao_decidiu"), run("c2", "nao_decidiu")],
      true,
    );
    expect(r.verdict).toBe("desmentida");
    expect(r.summary).toContain("não contam");
    expect(r.summary).toContain("c2");
    // O run continua visível com o que o juiz decidiu.
    expect(r.runs.map((x) => x.outcome)).toEqual(["desmente", "confirma"]);
  });

  test("vale pro outro lado também: confirmação fica de pé sem o desmente fora da causa", () => {
    const r = parseJudgment(
      raw({
        verdict: "confirmada",
        summary: "",
        runs: [
          { id: "c1", outcome: "confirma" },
          { id: "c2", outcome: "desmente", measures_cause: false },
        ],
      }),
      [run("c1", "nao_decidiu"), run("c2", "nao_decidiu")],
      true,
    );
    expect(r.verdict).toBe("confirmada");
  });

  test("se só sobram testes fora da causa, fica inconclusiva", () => {
    const r = parseJudgment(
      raw({
        verdict: "confirmada",
        summary: "",
        runs: [{ id: "c1", outcome: "confirma", measures_cause: false }],
      }),
      [run("c1", "nao_decidiu")],
      true,
    );
    expect(r.verdict).toBe("inconclusiva");
    expect(r.summary).toContain("c1");
  });

  test("sem measures_cause, o conflito continua conflito", () => {
    const r = parseJudgment(
      raw({
        verdict: "desmentida",
        summary: "",
        runs: [
          { id: "c1", outcome: "desmente" },
          { id: "c2", outcome: "confirma" },
        ],
      }),
      [run("c1", "nao_decidiu"), run("c2", "nao_decidiu")],
      true,
    );
    expect(r.verdict).toBe("inconclusiva");
  });
});

describe("measures_cause e novas linhas", () => {
  test("o juiz marca o teste fora da causa e ele fica gravado; desmentida traz novas linhas", () => {
    const runs = [
      {
        check: { id: "c1", stage: "live", claim: "x" },
        outcome: "nao_decidiu",
        observed: "",
        screenshot_url: null,
        source_ref: null,
      },
      {
        check: { id: "c2", stage: "repo", claim: "y" },
        outcome: "nao_decidiu",
        observed: "",
        screenshot_url: null,
        source_ref: null,
      },
    ] as never;
    const out = parseJudgment(
      JSON.stringify({
        verdict: "desmentida",
        runs: [
          { id: "c1", outcome: "desmente" },
          { id: "c2", outcome: "confirma", measures_cause: false },
        ],
        novas_linhas: ["olhar depois do clique", ""],
      }),
      runs,
      false,
    );
    expect(out.verdict).toBe("desmentida");
    expect(out.runs[1]?.measures_cause).toBe(false);
    expect(out.runs[0]?.measures_cause).toBeUndefined();
    expect(out.novas_linhas).toEqual(["olhar depois do clique"]);
  });

  test("confirmada não leva novas linhas", () => {
    const runs = [
      {
        check: { id: "c1", stage: "live", claim: "x" },
        outcome: "confirma",
        observed: "",
        screenshot_url: null,
        source_ref: null,
      },
    ] as never;
    const out = parseJudgment(
      JSON.stringify({ verdict: "confirmada", runs: [], novas_linhas: ["x"] }),
      runs,
      false,
    );
    expect(out.novas_linhas).toBeUndefined();
  });
});
