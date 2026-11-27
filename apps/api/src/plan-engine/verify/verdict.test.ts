import { describe, expect, test } from "bun:test";
import type { CheckOutcome, CheckRun } from "./types.ts";
import {
  confirmationStrength,
  confirmedConfidence,
  JUDGE_SYSTEM,
  parseJudgment,
  scrollForPrompt,
} from "./verdict.ts";

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
  test("all nao_testou becomes inconclusiva", () => {
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

  test("confirma + desmente is a conflict: inconclusiva, cites both, no rewrite", () => {
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

  test("a conflict with the model asking for a rewrite is still inconclusiva", () => {
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

  test("desmente with a complete rewrite becomes reescrita", () => {
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

  test("a rewrite with an empty field becomes desmentida", () => {
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

  test("allowRewrite false becomes desmentida", () => {
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

  test("the model changes neither nao_testou nor an already decided repo run", () => {
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

  test("unreadable output becomes inconclusiva without throwing", () => {
    const runs = [run("c1", "nao_decidiu")];
    const r = parseJudgment("blá", runs, true);
    expect(r.verdict).toBe("inconclusiva");
    expect(r.summary).toStartWith("a verificação não decidiu:");
    expect(r.runs).toEqual(runs);
  });

  test("a model summary contradicting the code's verdict is discarded", () => {
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

  test("a non-object JSON value does not throw", () => {
    for (const bad of ["null", "[]", "[1]"]) {
      const r = parseJudgment(bad, [run("c1", "nao_decidiu")], true);
      expect(r.verdict).toBe("inconclusiva");
      expect(r.summary).toStartWith("a verificação não decidiu:");
    }
  });

  test("model says confirmada but no decided run becomes inconclusiva", () => {
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

  test("only confirma with the model saying reescrita becomes confirmada without rewrite", () => {
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

// The judge gets measured scroll and page height, not a bare pixel value.
describe("scrollForPrompt", () => {
  test("joins per-device reach with the captured page height", () => {
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

  test("without a capture for the device, does not invent a height", () => {
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

describe("judge position yardstick: fold by screen height, bottom by reach", () => {
  test("the judge gets the screen height as the fold", () => {
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

  test("a capture without device scroll still gives the screen height", () => {
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

  test("the rule separates fold from reach", () => {
    expect(JUDGE_SYSTEM).toContain("ALTURA DA TELA");
    expect(JUDGE_SYSTEM).toContain(
      "Um teste de alcance não decide uma hipótese de dobra",
    );
  });
});

describe("check that does not measure the cause", () => {
  test("leaves both sides: the check measuring the cause decides", () => {
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
    // The run stays visible with what the judge decided.
    expect(r.runs.map((x) => x.outcome)).toEqual(["desmente", "confirma"]);
  });

  test("works the other way too: a confirmation stands without the off-cause refutation", () => {
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

  test("if only off-cause checks remain, it is inconclusiva", () => {
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

  test("without measures_cause, a conflict stays a conflict", () => {
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

describe("measures_cause and novas_linhas", () => {
  test("the judge flags the off-cause check and it is stored; desmentida carries novas_linhas", () => {
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

  test("confirmada carries no novas_linhas", () => {
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

describe("confirmationStrength", () => {
  const at = (
    id: string,
    stage: "live" | "repo" | "data",
    device: "mobile" | "desktop" = "mobile",
    outcome: CheckOutcome = "confirma",
  ): CheckRun => {
    const r = run(id, outcome);
    return { ...r, check: { ...r.check, stage, device } };
  };

  test("the code and the page agreeing is corroborated", () => {
    expect(confirmationStrength([at("c1", "repo"), at("c2", "live")])).toBe(
      "corroborada",
    );
  });

  test("the same page on both screens is corroborated; two checks on one screen are not", () => {
    expect(
      confirmationStrength([at("c1", "live"), at("c2", "live", "desktop")]),
    ).toBe("corroborada");
    expect(confirmationStrength([at("c1", "live"), at("c2", "live")])).toBe(
      "isolada",
    );
  });

  test("a check off the cause or undecided does not corroborate", () => {
    expect(
      confirmationStrength([
        at("c1", "repo"),
        { ...at("c2", "live"), measures_cause: false },
        at("c3", "data", "mobile", "nao_decidiu"),
      ]),
    ).toBe("isolada");
  });

  test("the boost follows the strength and stops at 0.9", () => {
    expect(confirmedConfidence(0.5, "corroborada")).toBeCloseTo(0.7);
    expect(confirmedConfidence(0.5, "isolada")).toBeCloseTo(0.6);
    expect(confirmedConfidence(0.85, "corroborada")).toBeCloseTo(0.9);
  });
});
