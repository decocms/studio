import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUSINESS_CASE_AREAS,
  BUSINESS_CASE_CARD_KEYS,
  BUSINESS_CASE_LIMITS,
  BUSINESS_CASE_METRIC_UNITS,
  BusinessCaseSchema,
} from "@decocms/shared/business-case";
import {
  AREAS,
  CARD_KEYS,
  LIMITS,
  METRIC_UNITS,
} from "./image/skills/business-case/business-case-canvas.mjs";
import {
  abTest,
  money,
} from "./image/skills/business-case/business-case-math.mjs";

const CLI = fileURLToPath(
  new URL(
    "./image/skills/business-case/business-case-canvas.mjs",
    import.meta.url,
  ),
);

let root: string;
let path: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "business-case-"));
  path = join(root, "plans/cases/thread-1.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Runs the CLI the way the skill does. */
function run(args: string[]) {
  const res = Bun.spawnSync(["bun", CLI, ...args]);
  return {
    code: res.exitCode,
    stderr: res.stderr.toString(),
  };
}

function saved() {
  return BusinessCaseSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function init(extra: string[] = []) {
  return run([
    "init",
    "--path",
    path,
    "--title",
    "Melhorar a busca",
    "--request",
    "quero mexer na busca",
    "--area",
    "search",
    ...extra,
  ]);
}

describe("business-case-canvas", () => {
  it("keeps the shape and limits of the shared schema", () => {
    expect(CARD_KEYS).toEqual([...BUSINESS_CASE_CARD_KEYS]);
    expect(AREAS).toEqual([...BUSINESS_CASE_AREAS]);
    expect(LIMITS).toEqual({ ...BUSINESS_CASE_LIMITS });
    expect(METRIC_UNITS).toEqual([...BUSINESS_CASE_METRIC_UNITS]);
  });

  it("init writes a case the web can read, every card empty", () => {
    const { code } = init(["--objective", "Vender mais no celular"]);
    expect(code).toBe(0);
    const value = saved();
    expect(value.status).toBe("framing");
    expect(value.objective).toBe("Vender mais no celular");
    expect(value.request).toEqual({
      text: "quero mexer na busca",
      area: "search",
    });
    for (const key of BUSINESS_CASE_CARD_KEYS) {
      expect(value.cards[key].state).toBe("empty");
    }
  });

  it("init without a goal stores null", () => {
    init();
    expect(saved().objective).toBeNull();
  });

  it("init again reframes and keeps the cards", () => {
    init();
    run(["set", "--path", path, "--card", "problem", "--summary", "33% saem"]);
    run([
      "init",
      "--path",
      path,
      "--title",
      "Busca sem resultado",
      "--request",
      "zerar a busca sem resultado",
    ]);
    const value = saved();
    expect(value.title).toBe("Busca sem resultado");
    expect(value.request.area).toBe("search");
    expect(value.cards.problem.summary).toBe("33% saem");
  });

  it("ask marks one card at a time", () => {
    init();
    run(["ask", "--path", path, "--card", "scope"]);
    expect(saved().cards.scope.state).toBe("asking");
    run(["ask", "--path", path, "--card", "problem"]);
    const value = saved();
    expect(value.cards.scope.state).toBe("empty");
    expect(value.cards.problem.state).toBe("asking");
  });

  it("set fills a card with bullets and sources and moves to building", () => {
    init();
    run(["ask", "--path", path, "--card", "scope"]);
    const { code } = run([
      "set",
      "--path",
      path,
      "--card",
      "scope",
      "--summary",
      "Busca sem resultado no celular",
      "--bullet",
      "Sugerir termos parecidos",
      "--bullet",
      "Mostrar mais vendidos",
      "--source",
      "Data lake, 7 dias",
      "--source",
      "Concorrente|https://example.com/busca",
      "--assumption",
      "Celular é onde mais acontece",
    ]);
    expect(code).toBe(0);
    const value = saved();
    expect(value.status).toBe("building");
    expect(value.cards.scope).toEqual({
      state: "filled",
      summary: "Busca sem resultado no celular",
      bullets: ["Sugerir termos parecidos", "Mostrar mais vendidos"],
      sources: [
        { label: "Data lake, 7 dias" },
        { label: "Concorrente", url: "https://example.com/busca" },
      ],
      assumption: "Celular é onde mais acontece",
    });
  });

  it("finish settles a pending question and links the document", () => {
    init();
    run(["ask", "--path", path, "--card", "risks"]);
    run([
      "finish",
      "--path",
      path,
      "--document",
      "/app/org/home/plans/2026-11-18-busca.md",
    ]);
    const value = saved();
    expect(value.status).toBe("ready");
    expect(value.cards.risks.state).toBe("empty");
    expect(value.documentPath).toBe("plans/2026-11-18-busca.md");
  });

  it("rejects an unknown card and writes nothing", () => {
    init();
    const before = readFileSync(path, "utf8");
    const { code, stderr } = run([
      "set",
      "--path",
      path,
      "--card",
      "roi",
      "--summary",
      "x",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--card must be one of");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("rejects text over the limit, an unknown area and a bad url", () => {
    init();
    const long = run([
      "set",
      "--path",
      path,
      "--card",
      "problem",
      "--summary",
      "x".repeat(BUSINESS_CASE_LIMITS.text + 1),
    ]);
    expect(long.code).toBe(1);
    expect(long.stderr).toContain("the limit is 600");

    const area = run(["init", "--path", path, "--area", "everywhere"]);
    expect(area.code).toBe(1);
    expect(area.stderr).toContain("area must be one of");

    const url = run([
      "set",
      "--path",
      path,
      "--card",
      "competitors",
      "--summary",
      "x",
      "--source",
      "Loja|not a url",
    ]);
    expect(url.code).toBe(1);
    expect(url.stderr).toContain("is not a URL");
  });

  it("rejects more bullets than a card holds", () => {
    init();
    const bullets = Array.from(
      { length: BUSINESS_CASE_LIMITS.items + 1 },
      (_, i) => ["--bullet", `b${i}`],
    ).flat();
    const { code, stderr } = run([
      "set",
      "--path",
      path,
      "--card",
      "risks",
      "--summary",
      "x",
      ...bullets,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("at most 8");
  });

  it("only writes under plans/cases and needs init first", () => {
    const outside = run([
      "init",
      "--path",
      join(root, "notes.json"),
      "--title",
      "t",
      "--request",
      "r",
    ]);
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain("plans/cases/<chat id>.json");

    const missing = run(["ask", "--path", path, "--card", "scope"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("run init first");
    expect(existsSync(path)).toBe(false);
  });

  it("ask keeps the question as asked, and settling drops it", () => {
    init();
    run([
      "ask",
      "--path",
      path,
      "--card",
      "money",
      "--question",
      "Qual é a margem por pedido?",
    ]);
    expect(saved().cards.money).toMatchObject({
      state: "asking",
      question: "Qual é a margem por pedido?",
    });
    run(["set", "--path", path, "--card", "scope", "--summary", "PDP"]);
    expect(saved().cards.money.question).toBeUndefined();
    expect(saved().cards.money.state).toBe("empty");
  });

  it("set --metric stores metrics on problem and effort", () => {
    init();
    const { code } = run([
      "set",
      "--path",
      path,
      "--card",
      "problem",
      "--summary",
      "41% saem no frete",
      "--metric",
      "Nossa loja|41|percent",
      "--metric",
      "Média do setor|24.5|percent",
    ]);
    expect(code).toBe(0);
    expect(saved().cards.problem.metrics).toEqual([
      { label: "Nossa loja", value: 41, unit: "percent" },
      { label: "Média do setor", value: 24.5, unit: "percent" },
    ]);
  });

  it("rejects a metric on another card, a bad unit, a bad number or too many", () => {
    init();
    const set = (card: string, ...metrics: string[]) =>
      run([
        "set",
        "--path",
        path,
        "--card",
        card,
        "--summary",
        "x",
        ...metrics.flatMap((m) => ["--metric", m]),
      ]);
    const scope = set("scope", "Loja|1|percent");
    expect(scope.code).toBe(1);
    expect(scope.stderr).toContain("only problem and effort carry metrics");
    const unit = set("problem", "Loja|1|miles");
    expect(unit.code).toBe(1);
    expect(unit.stderr).toContain("unit must be one of");
    const number = set("problem", "Loja|muito|percent");
    expect(number.code).toBe(1);
    expect(number.stderr).toContain("is not a number");
    const many = set(
      "problem",
      ...Array.from(
        { length: BUSINESS_CASE_LIMITS.metrics + 1 },
        (_, i) => `m${i}|${i}|count`,
      ),
    );
    expect(many.code).toBe(1);
    expect(many.stderr).toContain("at most 4 metrics");
  });

  it("set on money runs the math and keeps its numbers", () => {
    init();
    const { code } = run([
      "set",
      "--path",
      path,
      "--card",
      "money",
      "--summary",
      "R$ 38 mil por mês",
      "--base",
      "104000",
      "--delta-pp",
      "1.5",
      "--value",
      "73",
      "--gap-pp",
      "17",
      "--base-label",
      "carrinhos por mês",
      "--value-label",
      "receita por pedido a mais",
    ]);
    expect(code).toBe(0);
    const expected = money({
      base: 104000,
      deltaPp: 1.5,
      value: 73,
      gapPp: 17,
    });
    expect(saved().cards.money.calc).toEqual({
      kind: "money",
      base: 104000,
      baseLabel: "carrinhos por mês",
      deltaPp: 1.5,
      value: 73,
      valueLabel: "receita por pedido a mais",
      gapPp: 17,
      monthlyValue: expected.monthly_value,
      ceilingMonthly: expected.ceiling_monthly,
    });
  });

  it("tells the agent when the math moves its number, without writing it on the card", () => {
    init();
    const res = run([
      "set",
      "--path",
      path,
      "--card",
      "money",
      "--summary",
      "x",
      "--base",
      "1000",
      "--delta-pp",
      "9",
      "--value",
      "50",
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("delta-pp 9 moved to 3");
    const card = saved().cards.money;
    expect(card.calc).toMatchObject({ deltaPp: 3 });
    expect(card.assumption).toBeUndefined();
  });

  it("rejects math that does not come out as finite numbers", () => {
    init();
    const before = readFileSync(path, "utf8");
    const { code, stderr } = run([
      "set",
      "--path",
      path,
      "--card",
      "money",
      "--summary",
      "x",
      "--base",
      "1e200",
      "--delta-pp",
      "1",
      "--value",
      "1e200",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("is not a finite number");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("set on abTest runs the math", () => {
    init();
    const { code } = run([
      "set",
      "--path",
      path,
      "--card",
      "abTest",
      "--summary",
      "3 semanas",
      "--baseline",
      "0.59",
      "--effect-pp",
      "1.5",
      "--weekly",
      "24000",
    ]);
    expect(code).toBe(0);
    const expected = abTest({ baseline: 0.59, effectPp: 1.5, weekly: 24000 });
    expect(saved().cards.abTest.calc).toEqual({
      kind: "abTest",
      baseline: 0.59,
      mdePp: expected.mde_pp,
      nPerGroup: expected.n_per_group,
      weeks: expected.weeks,
      measurable: expected.measurable,
    });
  });

  it("rejects math flags on the wrong card, partial inputs and inputs the math rejects", () => {
    init();
    const before = readFileSync(path, "utf8");
    const wrong = run([
      "set",
      "--path",
      path,
      "--card",
      "effort",
      "--summary",
      "x",
      "--base",
      "10",
    ]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("--base goes on the money card");
    const partial = run([
      "set",
      "--path",
      path,
      "--card",
      "money",
      "--summary",
      "x",
      "--base",
      "10",
    ]);
    expect(partial.code).toBe(1);
    expect(partial.stderr).toContain(
      "money needs --base, --delta-pp and --value",
    );
    const zero = run([
      "set",
      "--path",
      path,
      "--card",
      "money",
      "--summary",
      "x",
      "--base",
      "0",
      "--delta-pp",
      "1",
      "--value",
      "10",
    ]);
    expect(zero.code).toBe(1);
    expect(zero.stderr).toContain("base must be a number > 0");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("setting a card again without the math drops the old numbers", () => {
    init();
    run([
      "set",
      "--path",
      path,
      "--card",
      "money",
      "--summary",
      "x",
      "--base",
      "1000",
      "--delta-pp",
      "1",
      "--value",
      "50",
    ]);
    run([
      "set",
      "--path",
      path,
      "--card",
      "money",
      "--summary",
      "Sem dados de tráfego",
    ]);
    expect(saved().cards.money.calc).toBeUndefined();
  });
});
