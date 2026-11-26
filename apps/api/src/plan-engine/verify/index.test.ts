import { describe, expect, test } from "bun:test";
import { NoAiModelError } from "../ports.ts";
import type { UxHypothesis } from "../types.ts";
import { reverifyBlock, type VerifyDeps, verifyHypothesis } from "./index.ts";
import type { CheckRun, HypothesisVerification, VerifyCheck } from "./types.ts";
import type { JudgeResult, RewriteDraft } from "./verdict.ts";

const h = (over: Partial<UxHypothesis> = {}): UxHypothesis =>
  ({
    id: "h1",
    opportunity_id: "o1",
    title: "Título original",
    why: "Porquê original",
    idea: "ideia",
    where: "onde",
    evidence_md: "ev",
    device: "mobile",
    confidence: 0.8,
    ...over,
  }) as UxHypothesis;

const chk = (id: string, stage: "live" | "repo"): VerifyCheck => ({
  id,
  claim: "x",
  stage,
  device: "mobile",
  steps: [],
  question: stage === "repo" ? "q?" : null,
  confirms_if: "a",
  refutes_if: "b",
});
const run = (check: VerifyCheck): CheckRun => ({
  check,
  outcome: "nao_decidiu",
  observed: "o",
  screenshot_url: null,
  source_ref: null,
});
const judged = (
  verdict: JudgeResult["verdict"],
  rewrite: RewriteDraft | null = null,
): JudgeResult => ({ verdict, summary: `sum-${verdict}`, runs: [], rewrite });
const draft: RewriteDraft = {
  title: "Novo",
  why: "novo porquê",
  prediction: "vai acontecer X",
  evidence_md: "ev novo",
  idea: "ideia nova",
  where: "lugar novo",
};

function deps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    plan: async () => ({
      checks: [chk("c1", "live")],
      dropped: [],
      untestable: null,
    }),
    live: async (c) => run(c),
    repo: async (c) => ({ run: run(c), followup: null }),
    judge: async () => judged("confirmada"),
    now: () => "2026-11-13T00:00:00Z",
    timeLeft: () => Number.POSITIVE_INFINITY,
    ...over,
  };
}

describe("verifyHypothesis", () => {
  test("empty plan: inconclusive, without opening the browser", async () => {
    let liveCalls = 0;
    const out = await verifyHypothesis(
      h(),
      deps({
        plan: async () => ({ checks: [], dropped: [], untestable: null }),
        live: async (c) => {
          liveCalls++;
          return run(c);
        },
      }),
    );
    expect(out.kind).toBe("keep");
    expect(out.verification.verdict).toBe("inconclusiva");
    expect(out.verification.summary).toBe(
      "não há o que testar na página ou no código",
    );
    expect(liveCalls).toBe(0);
    if (out.kind === "keep") expect(out.confidence).toBe(0.8);
  });

  test("untestable becomes the summary", async () => {
    const out = await verifyHypothesis(
      h(),
      deps({
        plan: async () => ({
          checks: [],
          dropped: [],
          untestable: "é preferência da cliente",
        }),
      }),
    );
    expect(out.verification.summary).toBe("é preferência da cliente");
  });

  test("the repo followup joins the live queue", async () => {
    const seen: string[] = [];
    await verifyHypothesis(
      h(),
      deps({
        plan: async () => ({
          checks: [chk("c1", "repo")],
          dropped: [],
          untestable: null,
        }),
        repo: async (c) => ({ run: run(c), followup: chk("c1-f", "live") }),
        live: async (c) => {
          seen.push(c.id);
          return run(c);
        },
      }),
    );
    expect(seen).toEqual(["c1-f"]);
  });

  test("confirmed rewrite: rewrite, judge twice, second without rewrite", async () => {
    const calls: boolean[] = [];
    let n = 0;
    const out = await verifyHypothesis(
      h(),
      deps({
        judge: async (_h, _r, allow) => {
          calls.push(allow);
          return n++ === 0 ? judged("reescrita", draft) : judged("confirmada");
        },
      }),
    );
    expect(out.kind).toBe("rewrite");
    expect(out.verification.rewritten_from).toEqual({
      title: "Título original",
      why: "Porquê original",
    });
    expect(calls).toEqual([true, false]);
    if (out.kind === "rewrite") {
      expect(out.draft).toEqual(draft);
      expect(out.confidence).toBeCloseTo(0.9);
    }
  });

  test("the second pass sees the temporary hypothesis", async () => {
    const plans: UxHypothesis[] = [];
    let n = 0;
    await verifyHypothesis(
      h(),
      deps({
        plan: async (x) => {
          plans.push(x);
          return { checks: [chk("c1", "live")], dropped: [], untestable: null };
        },
        judge: async () =>
          n++ === 0 ? judged("reescrita", draft) : judged("inconclusiva"),
      }),
    );
    expect(plans[1]?.title).toBe("Novo");
    expect(plans[1]?.id).toBe("h1");
    expect(plans[1]?.confidence).toBe(0.8);
    expect(plans[1]?.evidence_md).toBe(
      "ev novo\n\n**Se for isso:** vai acontecer X",
    );
  });

  test("refuted rewrite: drop with the second summary", async () => {
    let n = 0;
    const out = await verifyHypothesis(
      h(),
      deps({
        judge: async () =>
          n++ === 0 ? judged("reescrita", draft) : judged("desmentida"),
      }),
    );
    expect(out.kind).toBe("drop");
    if (out.kind === "drop") expect(out.reason).toBe("sum-desmentida");
  });

  test("rewriting again on the second pass counts as refuted", async () => {
    const out = await verifyHypothesis(
      h(),
      deps({ judge: async () => judged("reescrita", draft) }),
    );
    expect(out.kind).toBe("drop");
  });

  test("plan throws: inconclusive, confidence untouched", async () => {
    const out = await verifyHypothesis(
      h(),
      deps({
        plan: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(out.kind).toBe("keep");
    expect(out.verification.verdict).toBe("inconclusiva");
    expect(out.verification.summary).toBe("a verificação falhou: boom");
    if (out.kind === "keep") expect(out.confidence).toBe(0.8);
  });

  test("confirmed raises 0.2, capped at 0.9", async () => {
    const out = await verifyHypothesis(h({ confidence: 0.8 }), deps());
    expect(out).toMatchObject({ kind: "keep" });
    expect((out as { confidence: number }).confidence).toBeCloseTo(0.9);
    const low = await verifyHypothesis(h({ confidence: 0.5 }), deps());
    expect(low).toMatchObject({ kind: "keep" });
    expect((low as { confidence: number }).confidence).toBeCloseTo(0.7);
  });

  test("repo throws: that test becomes nao_testou and the hypothesis continues", async () => {
    let judgedRuns: CheckRun[] = [];
    const out = await verifyHypothesis(
      h(),
      deps({
        plan: async () => ({
          checks: [chk("c1", "repo"), chk("c2", "live")],
          dropped: [],
          untestable: null,
        }),
        repo: async () => {
          throw new Error("repo caiu");
        },
        judge: async (_h, runs) => {
          judgedRuns = runs;
          return judged("confirmada");
        },
      }),
    );
    expect(out.kind).toBe("keep");
    expect(judgedRuns.map((r) => [r.check.id, r.outcome])).toEqual([
      ["c1", "nao_testou"],
      ["c2", "nao_decidiu"],
    ]);
  });

  test("repo without a model: the error ends the verification", async () => {
    const out = verifyHypothesis(
      h(),
      deps({
        plan: async () => ({
          checks: [chk("c1", "repo")],
          dropped: [],
          untestable: null,
        }),
        repo: async () => {
          throw new NoAiModelError();
        },
      }),
    );
    await expect(out).rejects.toBeInstanceOf(NoAiModelError);
  });

  test("live throws: that test becomes nao_testou and the hypothesis continues", async () => {
    let judgedRuns: CheckRun[] = [];
    await verifyHypothesis(
      h(),
      deps({
        plan: async () => ({
          checks: [chk("c1", "live"), chk("c2", "live")],
          dropped: [],
          untestable: null,
        }),
        live: async (c) => {
          if (c.id === "c1") throw new Error("chrome caiu");
          return run(c);
        },
        judge: async (_h, runs) => {
          judgedRuns = runs;
          return judged("inconclusiva");
        },
      }),
    );
    expect(judgedRuns.map((r) => r.outcome)).toEqual([
      "nao_testou",
      "nao_decidiu",
    ]);
  });

  test("judge throws: inconclusive, confidence untouched", async () => {
    const out = await verifyHypothesis(
      h(),
      deps({
        judge: async () => {
          throw new Error("juiz caiu");
        },
      }),
    );
    expect(out.kind).toBe("keep");
    expect(out.verification.verdict).toBe("inconclusiva");
    expect(out.verification.summary).toBe("a verificação falhou: juiz caiu");
    expect((out as { confidence: number }).confidence).toBe(0.8);
  });

  // The judge does not swap the cause; the one it would propose becomes an investigation line.
  test("rewrite not allowed: a rewrite becomes refuted, with the suggested cause in the lines", async () => {
    const allowed: boolean[] = [];
    const out = await verifyHypothesis(
      h(),
      deps({
        allowRewrite: false,
        judge: async (_h, _r, allow) => {
          allowed.push(allow);
          return {
            ...judged("reescrita", draft),
            novas_linhas: ["olhar a gaveta"],
          };
        },
      }),
    );
    expect(allowed).toEqual([false]);
    expect(out.kind).toBe("drop");
    expect(out.verification.verdict).toBe("desmentida");
    expect(out.verification.novas_linhas).toEqual([
      "olhar a gaveta",
      "outra causa: Novo",
    ]);
  });

  test("empty second plan: rewrite stays, original confidence", async () => {
    let n = 0;
    const out = await verifyHypothesis(
      h(),
      deps({
        plan: async () =>
          n++ === 0
            ? { checks: [chk("c1", "live")], dropped: [], untestable: null }
            : { checks: [], dropped: [], untestable: null },
        judge: async () => judged("reescrita", draft),
      }),
    );
    expect(out.kind).toBe("rewrite");
    expect((out as { confidence: number }).confidence).toBe(0.8);
  });

  test("repo runs before live, whatever the plan order", async () => {
    const order: string[] = [];
    await verifyHypothesis(
      h(),
      deps({
        plan: async () => ({
          checks: [chk("c1", "live"), chk("c2", "repo")],
          dropped: [],
          untestable: null,
        }),
        repo: async (c) => {
          order.push(c.id);
          return { run: run(c), followup: null };
        },
        live: async (c) => {
          order.push(c.id);
          return run(c);
        },
      }),
    );
    expect(order).toEqual(["c2", "c1"]);
  });

  test("refuted on the first pass: drop", async () => {
    const out = await verifyHypothesis(
      h(),
      deps({ judge: async () => judged("desmentida") }),
    );
    expect(out.kind).toBe("drop");
  });
});

describe("verify again", () => {
  const prior = (
    over: Partial<HypothesisVerification> = {},
  ): HypothesisVerification => ({
    verdict: "confirmada",
    summary: "antes",
    runs: [],
    rewritten_from: null,
    verified_at: "2026-11-12T00:00:00Z",
    ...over,
  });

  test("keeps the confidence from before verification", async () => {
    const out = await verifyHypothesis(h({ confidence: 0.5 }), deps());
    expect(out.verification.base_confidence).toBe(0.5);
  });

  test("confirming again does not raise twice: starts from the prior confidence", async () => {
    const out = await verifyHypothesis(
      h({ confidence: 0.7, verification: prior({ base_confidence: 0.5 }) }),
      deps(),
    );
    expect(out.kind).toBe("keep");
    if (out.kind === "keep") expect(out.confidence).toBeCloseTo(0.7);
    expect(out.verification.base_confidence).toBe(0.5);
  });

  test("inconclusive again: confidence as is, base kept", async () => {
    const out = await verifyHypothesis(
      h({ confidence: 0.7, verification: prior({ base_confidence: 0.5 }) }),
      deps({ judge: async () => judged("inconclusiva") }),
    );
    if (out.kind === "keep") expect(out.confidence).toBe(0.7);
    expect(out.verification.base_confidence).toBe(0.5);
  });

  test("old verification without base: the current confidence is the base", async () => {
    const out = await verifyHypothesis(
      h({ confidence: 0.6, verification: prior() }),
      deps(),
    );
    expect(out.verification.base_confidence).toBe(0.6);
    if (out.kind === "keep") expect(out.confidence).toBeCloseTo(0.8);
  });

  test("already rewritten: the judge cannot rewrite again", async () => {
    const original = { title: "A primeira", why: "o primeiro porquê" };
    const allowed: boolean[] = [];
    const out = await verifyHypothesis(
      h({
        verification: prior({ verdict: "reescrita", rewritten_from: original }),
      }),
      deps({
        judge: async (_h, _r, allow) => {
          allowed.push(allow);
          return judged("confirmada");
        },
      }),
    );
    expect(allowed).toEqual([false]);
    expect(out.kind).toBe("keep");
    expect(out.verification.rewritten_from).toEqual(original);
  });

  test("already rewritten and the judge rewrites anyway: counts as refuted", async () => {
    const original = { title: "A primeira", why: "o primeiro porquê" };
    let judges = 0;
    const out = await verifyHypothesis(
      h({
        verification: prior({ verdict: "reescrita", rewritten_from: original }),
      }),
      deps({
        judge: async () => {
          judges++;
          return judged("reescrita", draft);
        },
      }),
    );
    expect(out.kind).toBe("drop");
    expect(out.verification.verdict).toBe("desmentida");
    expect(judges).toBe(1);
  });

  test("confirming a rewrite keeps where it came from", async () => {
    const original = { title: "A primeira", why: "o primeiro porquê" };
    const out = await verifyHypothesis(
      h({
        verification: prior({ verdict: "reescrita", rewritten_from: original }),
      }),
      deps(),
    );
    expect(out.kind).toBe("keep");
    expect(out.verification.rewritten_from).toEqual(original);
  });
});

describe("deadline", () => {
  /** Fake clock: each test run spends `cost` ms of a `budget` deadline. */
  const clock = (budget: number, cost: number) => {
    let used = 0;
    return {
      timeLeft: () => budget - used,
      spend: () => {
        used += cost;
      },
    };
  };

  test("out of time from the start: no test runs, all 'sem tempo'", async () => {
    let liveCalls = 0;
    let repoCalls = 0;
    let seen: CheckRun[] = [];
    await verifyHypothesis(
      h(),
      deps({
        timeLeft: () => 0,
        plan: async () => ({
          checks: [chk("c1", "repo"), chk("c2", "live")],
          dropped: [],
          untestable: null,
        }),
        repo: async (c) => {
          repoCalls++;
          return { run: run(c), followup: null };
        },
        live: async (c) => {
          liveCalls++;
          return run(c);
        },
        judge: async (_h, runs) => {
          seen = runs;
          return judged("inconclusiva");
        },
      }),
    );
    expect(repoCalls).toBe(0);
    expect(liveCalls).toBe(0);
    expect(seen.map((r) => r.outcome)).toEqual(["nao_testou", "nao_testou"]);
    expect(seen.every((r) => r.observed === "sem tempo nesta rodada")).toBe(
      true,
    );
  });

  test("a test that would start past the deadline is 'sem tempo'; earlier ones run", async () => {
    const c = clock(1_000, 600);
    const ran: string[] = [];
    let seen: CheckRun[] = [];
    await verifyHypothesis(
      h(),
      deps({
        timeLeft: c.timeLeft,
        plan: async () => ({
          checks: [chk("c1", "live"), chk("c2", "live"), chk("c3", "live")],
          dropped: [],
          untestable: null,
        }),
        live: async (x) => {
          ran.push(x.id);
          c.spend();
          return run(x);
        },
        judge: async (_h, runs) => {
          seen = runs;
          return judged("inconclusiva");
        },
      }),
    );
    expect(ran).toEqual(["c1", "c2"]);
    expect(seen.map((r) => [r.check.id, r.outcome])).toEqual([
      ["c1", "nao_decidiu"],
      ["c2", "nao_decidiu"],
      ["c3", "nao_testou"],
    ]);
    expect(seen[2]?.observed).toBe("sem tempo nesta rodada");
  });

  test("rewrite without time for the second verification: stays as it was", async () => {
    const c = clock(1_000, 1_000);
    let plans = 0;
    let judges = 0;
    const out = await verifyHypothesis(
      h({ confidence: 0.6 }),
      deps({
        timeLeft: c.timeLeft,
        plan: async () => {
          plans++;
          return { checks: [chk("c1", "live")], dropped: [], untestable: null };
        },
        live: async (x) => {
          c.spend();
          return run(x);
        },
        judge: async () => {
          judges++;
          return judged("reescrita", draft);
        },
      }),
    );
    expect(plans).toBe(1);
    expect(judges).toBe(1);
    expect(out.kind).toBe("keep");
    expect(out.verification.verdict).toBe("inconclusiva");
    expect(out.verification.summary).toContain("sem tempo nesta rodada");
    expect(out.verification.rewritten_from).toBeNull();
    if (out.kind === "keep") expect(out.confidence).toBe(0.6);
  });
});

describe("reverifyBlock", () => {
  test("pending without 'ver no código': may verify again", () => {
    expect(
      reverifyBlock(h({ status: "pending", code_status: null })),
    ).toBeNull();
  });

  test("approved: refuses, verification could rewrite or delete", () => {
    expect(
      reverifyBlock(h({ status: "approved", code_status: null })),
    ).toContain("já foi aprovada (ou tem 'ver no código')");
  });

  test("with 'ver no código' (even pending or errored): refuses", () => {
    for (const code_status of ["running", "done", "error"] as const) {
      expect(reverifyBlock(h({ status: "pending", code_status }))).toContain(
        "ver no código",
      );
    }
  });

  test("discarded: refuses", () => {
    expect(
      reverifyBlock(h({ status: "dismissed", code_status: null })),
    ).toContain("descartada");
  });
});
