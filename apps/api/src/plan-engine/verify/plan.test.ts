import { describe, expect, test } from "bun:test";
import { PLAN_SYSTEM, parsePlan, validateSteps } from "./plan.ts";

const ctx = { elementKeys: new Set(["r|2"]) };
const live = (over: Record<string, unknown> = {}) => ({
  claim: "o botão some",
  stage: "live",
  device: "mobile",
  steps: [
    { op: "open" },
    { op: "inspect", target: { kind: "part", part: "price" } },
  ],
  confirms_if: "sim",
  refutes_if: "não",
  ...over,
});
const plan = (checks: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ checks, ...extra });

describe("parsePlan", () => {
  test("corta em 4 testes", () => {
    const r = parsePlan(plan(Array.from({ length: 6 }, () => live())), ctx);
    expect(r.checks.length).toBe(4);
    expect(r.checks.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  test("op fora da lista derruba o teste", () => {
    const r = parsePlan(
      plan([live({ steps: [{ op: "eval", code: "alert(1)" }] })]),
      ctx,
    );
    expect(r.checks.length).toBe(0);
    expect(r.dropped[0]).toContain("passo");
  });

  test("elemento fora das capturas derruba o teste", () => {
    const r = parsePlan(
      plan([
        live({
          steps: [{ op: "click", target: { kind: "element", key: "x|1" } }],
        }),
      ]),
      ctx,
    );
    expect(r.checks.length).toBe(0);
    expect(r.dropped.length).toBe(1);
    expect(r.dropped[0]).toContain("x|1");
  });

  test("elemento conhecido passa", () => {
    const r = parsePlan(
      plan([
        live({
          steps: [{ op: "click", target: { kind: "element", key: "r|2" } }],
        }),
      ]),
      ctx,
    );
    expect(r.checks.length).toBe(1);
  });

  test("insere open quando falta", () => {
    const r = parsePlan(
      plan([
        live({
          steps: [{ op: "inspect", target: { kind: "part", part: "price" } }],
        }),
      ]),
      ctx,
    );
    expect(r.checks[0]?.steps[0]).toEqual({ op: "open" });
  });

  test("wait é limitado a 8000 ms", () => {
    const r = parsePlan(
      plan([live({ steps: [{ op: "wait", ms: 20000 }] })]),
      ctx,
    );
    const w = r.checks[0]?.steps.find((s) => s.op === "wait");
    expect(w).toEqual({ op: "wait", ms: 8000 });
  });

  test("passa de 8 passos (contando o open) derruba com motivo", () => {
    const steps = Array.from({ length: 8 }, () => ({ op: "reload" }));
    const r = parsePlan(plan([live({ steps })]), ctx);
    expect(r.checks.length).toBe(0);
    expect(r.dropped[0]).toContain("passo");
  });

  test("lista vazia traz o untestable", () => {
    const r = parsePlan(
      plan([], { untestable: "preferência da cliente" }),
      ctx,
    );
    expect(r.checks).toEqual([]);
    expect(r.untestable).toBe("preferência da cliente");
  });

  test("repo sem question derruba; com question passa", () => {
    const bad = parsePlan(
      plan([live({ stage: "repo", steps: [], question: "" })]),
      ctx,
    );
    expect(bad.checks.length).toBe(0);
    const ok = parsePlan(
      plan([
        live({ stage: "repo", steps: [], question: "há estado sem estoque?" }),
      ]),
      ctx,
    );
    expect(ok.checks[0]?.question).toBe("há estado sem estoque?");
    expect(ok.checks[0]?.steps).toEqual([]);
  });

  test("stage inválido, live sem passos e confirms_if vazio derrubam", () => {
    const r = parsePlan(
      plan([
        live({ stage: "xx" }),
        live({ steps: [] }),
        live({ confirms_if: " " }),
        live({ refutes_if: "" }),
      ]),
      ctx,
    );
    expect(r.checks.length).toBe(0);
    expect(r.dropped.length).toBe(4);
  });

  test("JSON inválido lança", () => {
    expect(() => parsePlan("nada", ctx)).toThrow();
  });
});

test("inválidos não gastam vaga dos válidos", () => {
  const bad = () => live({ stage: "xx" });
  const r = parsePlan(plan([bad(), bad(), bad(), bad(), live()]), ctx);
  expect(r.checks.length).toBe(1);
  expect(r.checks[0]?.id).toBe("c1");
  expect(r.dropped.length).toBe(4);
});

describe("validateSteps", () => {
  test("descarta campos extras: só sobra o vocabulário fechado", () => {
    const r = validateSteps(
      [
        {
          op: "click",
          target: { kind: "part", part: "price", selector: "x" },
          code: "y",
        },
      ],
      ctx,
    );
    expect(r).toEqual({
      steps: [
        { op: "open" },
        { op: "click", target: { kind: "part", part: "price" } },
      ],
    });
  });

  test("parte inexistente é rejeitada", () => {
    const r = validateSteps(
      [{ op: "click", target: { kind: "part", part: "foo" } }],
      ctx,
    );
    expect("error" in r).toBe(true);
  });

  test("operação com alvo sem alvo é rejeitada", () => {
    expect("error" in validateSteps([{ op: "click" }], ctx)).toBe(true);
  });

  test("devolve erro pra não-array", () => {
    expect("error" in validateSteps("x", ctx)).toBe(true);
  });

  test("keep_overlays booleano no open e no reload é preservado", () => {
    const r = validateSteps(
      [
        { op: "open", keep_overlays: true },
        { op: "reload", keep_overlays: false },
      ],
      ctx,
    );
    expect(r).toEqual({
      steps: [
        { op: "open", keep_overlays: true },
        { op: "reload", keep_overlays: false },
      ],
    });
  });

  test("keep_overlays de outro tipo some; o resto do passo continua fechado", () => {
    const r = validateSteps(
      [
        { op: "open", keep_overlays: "true", code: "x" },
        { op: "reload", keep_overlays: 1 },
        { op: "choose_size", keep_overlays: true },
      ],
      ctx,
    );
    expect(r).toEqual({
      steps: [{ op: "open" }, { op: "reload" }, { op: "choose_size" }],
    });
  });

  test("o open auto-inserido é sem keep_overlays", () => {
    const r = validateSteps([{ op: "reload", keep_overlays: true }], ctx);
    expect(r).toEqual({
      steps: [{ op: "open" }, { op: "reload", keep_overlays: true }],
    });
  });
});

// 14/11: dobra = altura da tela; fundo = alcance.
describe("regra de posição do plano", () => {
  test("separa dobra (altura da tela) de fundo (alcance), com exemplo de cada", () => {
    const dobra = PLAN_SYSTEM.split("\n").find((l) =>
      l.includes('"abaixo da dobra"'),
    );
    const fundo = PLAN_SYSTEM.split("\n").find((l) =>
      l.includes('"no fundo da página"'),
    );
    expect(dobra).toContain("ALTURA DA TELA");
    expect(dobra).toContain("alcance não entra");
    expect(dobra).toContain("Ex.:");
    expect(fundo).toContain("alcance medido");
    expect(fundo).toContain("Ex.:");
    expect(PLAN_SYSTEM).not.toContain('"abaixo da dobra", "ninguém chega lá"');
  });
});

describe("validateSteps: gesture", () => {
  test("aceita gesture e descarta os campos extras", () => {
    const r = validateSteps(
      [
        { op: "open", keep_overlays: true },
        {
          op: "gesture",
          x: 10,
          y: 20,
          click: true,
          target: { kind: "part", part: "buy_button" },
        },
        { op: "wait", ms: 8000 },
      ],
      ctx,
    );
    expect(r).toEqual({
      steps: [
        { op: "open", keep_overlays: true },
        { op: "gesture" },
        { op: "wait", ms: 8000 },
      ],
    });
  });

  test("o plano explica o pop-up que abre no primeiro gesto", () => {
    expect(PLAN_SYSTEM).toContain('{"op":"gesture"}');
    expect(PLAN_SYSTEM).toContain('"keep_overlays":true');
  });
});

// 14/11: clicar no "comprar" é sempre bloqueado; o teste só gastava uma abertura.
describe("clique no botão de compra", () => {
  test("click e observe_click no buy_button derrubam o teste com o motivo", () => {
    for (const op of ["click", "observe_click"]) {
      const r = validateSteps(
        [{ op, target: { kind: "part", part: "buy_button" } }],
        ctx,
      );
      expect("error" in r && r.error).toContain("pergunte ao código");
    }
  });
  test("inspect e screenshot do buy_button continuam valendo", () => {
    const r = validateSteps(
      [
        { op: "inspect", target: { kind: "part", part: "buy_button" } },
        { op: "screenshot", target: { kind: "part", part: "buy_button" } },
      ],
      ctx,
    );
    expect("steps" in r).toBe(true);
  });
});
