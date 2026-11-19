import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUSINESS_CASE_AREAS,
  BUSINESS_CASE_CARD_KEYS,
  BUSINESS_CASE_LIMITS,
  BusinessCaseSchema,
} from "@decocms/shared/business-case";
import {
  AREAS,
  CARD_KEYS,
  LIMITS,
} from "./image/skills/business-case/business-case-canvas.mjs";

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
});
