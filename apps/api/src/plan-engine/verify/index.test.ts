import { describe, expect, test } from "bun:test";
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
  test("plano vazio: inconclusiva, sem abrir o navegador", async () => {
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

  test("untestable vira o resumo", async () => {
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

  test("followup do repo entra na fila live", async () => {
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

  test("reescrita confirmada: rewrite, judge 2x, segunda sem reescrita", async () => {
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

  test("a segunda passada vê a hipótese temporária", async () => {
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

  test("reescrita desmentida: drop com o resumo da segunda", async () => {
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

  test("reescrita de novo na segunda vale desmentida", async () => {
    const out = await verifyHypothesis(
      h(),
      deps({ judge: async () => judged("reescrita", draft) }),
    );
    expect(out.kind).toBe("drop");
  });

  test("plan lança: inconclusiva, confiança intacta", async () => {
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

  test("confirmada sobe 0.2, com teto 0.9", async () => {
    const out = await verifyHypothesis(h({ confidence: 0.8 }), deps());
    expect(out).toMatchObject({ kind: "keep" });
    expect((out as { confidence: number }).confidence).toBeCloseTo(0.9);
    const low = await verifyHypothesis(h({ confidence: 0.5 }), deps());
    expect(low).toMatchObject({ kind: "keep" });
    expect((low as { confidence: number }).confidence).toBeCloseTo(0.7);
  });

  test("repo lança: aquele teste vira nao_testou e a hipótese segue", async () => {
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

  test("live lança: aquele teste vira nao_testou e a hipótese segue", async () => {
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

  test("judge lança: inconclusiva, confiança intacta", async () => {
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

  // 19/11: o juiz não troca a causa; a que ele proporia vira linha de investigação.
  test("sem reescrita permitida: reescrita vira desmentida, com a causa sugerida nas linhas", async () => {
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

  test("segundo plano vazio: rewrite fica, confiança original", async () => {
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

  test("repo roda antes do live, qualquer que seja a ordem do plano", async () => {
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

  test("desmentida na primeira: drop", async () => {
    const out = await verifyHypothesis(
      h(),
      deps({ judge: async () => judged("desmentida") }),
    );
    expect(out.kind).toBe("drop");
  });
});

describe("verificar de novo", () => {
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

  test("guarda a confiança de antes da verificação", async () => {
    const out = await verifyHypothesis(h({ confidence: 0.5 }), deps());
    expect(out.verification.base_confidence).toBe(0.5);
  });

  test("confirmar de novo não sobe outra vez: parte da confiança de antes", async () => {
    const out = await verifyHypothesis(
      h({ confidence: 0.7, verification: prior({ base_confidence: 0.5 }) }),
      deps(),
    );
    expect(out.kind).toBe("keep");
    if (out.kind === "keep") expect(out.confidence).toBeCloseTo(0.7);
    expect(out.verification.base_confidence).toBe(0.5);
  });

  test("inconclusiva de novo: confiança como está, base preservada", async () => {
    const out = await verifyHypothesis(
      h({ confidence: 0.7, verification: prior({ base_confidence: 0.5 }) }),
      deps({ judge: async () => judged("inconclusiva") }),
    );
    if (out.kind === "keep") expect(out.confidence).toBe(0.7);
    expect(out.verification.base_confidence).toBe(0.5);
  });

  test("verificação antiga sem base: a confiança atual é a base", async () => {
    const out = await verifyHypothesis(
      h({ confidence: 0.6, verification: prior() }),
      deps(),
    );
    expect(out.verification.base_confidence).toBe(0.6);
    if (out.kind === "keep") expect(out.confidence).toBeCloseTo(0.8);
  });

  test("já reescrita: o juiz não pode reescrever de novo", async () => {
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

  test("já reescrita e o juiz reescreve mesmo assim: vale desmentida", async () => {
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

  test("confirmar uma reescrita não apaga de onde ela veio", async () => {
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

describe("prazo", () => {
  /** Relógio falso: cada teste rodado gasta `cost` ms de um prazo de `budget`. */
  const clock = (budget: number, cost: number) => {
    let used = 0;
    return {
      timeLeft: () => budget - used,
      spend: () => {
        used += cost;
      },
    };
  };

  test("sem tempo desde o começo: nenhum teste roda, todos 'sem tempo'", async () => {
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

  test("teste que começaria depois do prazo sai 'sem tempo'; os de antes rodam", async () => {
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

  test("reescrita sem tempo pra segunda verificação: fica como estava", async () => {
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
  test("pendente sem 'ver no código': pode verificar de novo", () => {
    expect(
      reverifyBlock(h({ status: "pending", code_status: null })),
    ).toBeNull();
  });

  test("aprovada: recusa, a verificação pode reescrever ou apagar", () => {
    expect(
      reverifyBlock(h({ status: "approved", code_status: null })),
    ).toContain("já foi aprovada (ou tem 'ver no código')");
  });

  test("com 'ver no código' (mesmo pendente ou com erro): recusa", () => {
    for (const code_status of ["running", "done", "error"] as const) {
      expect(reverifyBlock(h({ status: "pending", code_status }))).toContain(
        "ver no código",
      );
    }
  });

  test("descartada: recusa", () => {
    expect(
      reverifyBlock(h({ status: "dismissed", code_status: null })),
    ).toContain("descartada");
  });
});
