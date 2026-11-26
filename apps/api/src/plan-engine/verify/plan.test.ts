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
  test("truncates to 4 tests", () => {
    const r = parsePlan(plan(Array.from({ length: 6 }, () => live())), ctx);
    expect(r.checks.length).toBe(4);
    expect(r.checks.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  test("an op outside the list drops the test", () => {
    const r = parsePlan(
      plan([live({ steps: [{ op: "eval", code: "alert(1)" }] })]),
      ctx,
    );
    expect(r.checks.length).toBe(0);
    expect(r.dropped[0]).toContain("passo");
  });

  test("an element missing from the captures drops the test", () => {
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

  test("a known element passes", () => {
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

  test("inserts open when missing", () => {
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

  test("wait is capped at 8000 ms", () => {
    const r = parsePlan(
      plan([live({ steps: [{ op: "wait", ms: 20000 }] })]),
      ctx,
    );
    const w = r.checks[0]?.steps.find((s) => s.op === "wait");
    expect(w).toEqual({ op: "wait", ms: 8000 });
  });

  test("over 8 steps (counting open) drops with a reason", () => {
    const steps = Array.from({ length: 8 }, () => ({ op: "reload" }));
    const r = parsePlan(plan([live({ steps })]), ctx);
    expect(r.checks.length).toBe(0);
    expect(r.dropped[0]).toContain("passo");
  });

  test("an empty list carries untestable", () => {
    const r = parsePlan(
      plan([], { untestable: "preferência da cliente" }),
      ctx,
    );
    expect(r.checks).toEqual([]);
    expect(r.untestable).toBe("preferência da cliente");
  });

  test("repo without question drops; with question passes", () => {
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

  test("invalid stage, live without steps and empty confirms_if drop", () => {
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

  test("invalid JSON throws", () => {
    expect(() => parsePlan("nada", ctx)).toThrow();
  });
});

test("invalid tests do not take slots from valid ones", () => {
  const bad = () => live({ stage: "xx" });
  const r = parsePlan(plan([bad(), bad(), bad(), bad(), live()]), ctx);
  expect(r.checks.length).toBe(1);
  expect(r.checks[0]?.id).toBe("c1");
  expect(r.dropped.length).toBe(4);
});

describe("validateSteps", () => {
  test("drops extra fields: only the closed vocabulary remains", () => {
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

  test("an unknown part is rejected", () => {
    const r = validateSteps(
      [{ op: "click", target: { kind: "part", part: "foo" } }],
      ctx,
    );
    expect("error" in r).toBe(true);
  });

  test("a target op without a target is rejected", () => {
    expect("error" in validateSteps([{ op: "click" }], ctx)).toBe(true);
  });

  test("returns an error for a non-array", () => {
    expect("error" in validateSteps("x", ctx)).toBe(true);
  });

  test("a boolean keep_overlays on open and reload is kept", () => {
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

  test("keep_overlays of another type is dropped; the rest of the step stays closed", () => {
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

  test("the auto-inserted open has no keep_overlays", () => {
    const r = validateSteps([{ op: "reload", keep_overlays: true }], ctx);
    expect(r).toEqual({
      steps: [{ op: "open" }, { op: "reload", keep_overlays: true }],
    });
  });
});

// Fold = screen height; bottom = reach.
describe("plan position rule", () => {
  test("separates fold (screen height) from bottom (reach), with an example of each", () => {
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
  test("accepts gesture and drops extra fields", () => {
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

  test("the plan explains pop-ups that open on the first gesture", () => {
    expect(PLAN_SYSTEM).toContain('{"op":"gesture"}');
    expect(PLAN_SYSTEM).toContain('"keep_overlays":true');
  });
});

// Clicking buy is always blocked, so the test is dropped upfront instead of wasting a page open.
describe("clicking the buy button", () => {
  test("click and observe_click on buy_button drop the test with the reason", () => {
    for (const op of ["click", "observe_click"]) {
      const r = validateSteps(
        [{ op, target: { kind: "part", part: "buy_button" } }],
        ctx,
      );
      expect("error" in r && r.error).toContain("pergunte ao código");
    }
  });
  test("inspect and screenshot of buy_button stay valid", () => {
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
