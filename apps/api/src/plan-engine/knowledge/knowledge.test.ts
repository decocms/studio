import { describe, expect, test } from "bun:test";
import { UX_AREAS } from "../areas.ts";
import { PAGE_TYPES } from "../page-types.ts";
import type { UxHypothesis } from "../types.ts";
import type { HypothesisVerification } from "../verify/types.ts";
import { CURATED_KNOWLEDGE } from "./curated.ts";
import { areasFor, fromDecision, fromVerification } from "./learn.ts";
import {
  knowledgeForPrompt,
  resolveCitations,
  selectKnowledge,
} from "./select.ts";
import { ARTICLES, PUBLISHERS } from "./sources.ts";
import { type KnowledgeEntry, NEEDS_URL } from "./types.ts";

const store = (over: Partial<KnowledgeEntry>): KnowledgeEntry => ({
  ...CURATED_KNOWLEDGE[0]!,
  id: "s1",
  origem: "manual",
  tipo_fonte: "ab_desta_loja",
  conhecimento: "A/B da loja",
  areas: ["leve_o_look"],
  updated_at: new Date().toISOString(),
  ...over,
});

describe("curated base", () => {
  test("every curated article has a publisher and title (otherwise it vanishes from the folders)", () => {
    const editoras = new Set(PUBLISHERS.map((p) => p.key));
    const urls = new Set(CURATED_KNOWLEDGE.map((e) => e.fonte_url));
    for (const url of urls) {
      const artigo = url ? ARTICLES[url] : undefined;
      expect(artigo, `sem artigo: ${url}`).toBeDefined();
      expect(editoras.has(artigo?.editora ?? "outras")).toBe(true);
      expect(artigo?.titulo.length ?? 0).toBeGreaterThan(5);
    }
    // An article nobody cites is a leftover of a deleted entry.
    for (const url of Object.keys(ARTICLES)) expect(urls.has(url)).toBe(true);
  });

  test("unique ids, valid areas, https link, every entry with a finding and a limit", () => {
    const ids = new Set(CURATED_KNOWLEDGE.map((e) => e.id));
    expect(ids.size).toBe(CURATED_KNOWLEDGE.length);
    const areas = new Set(Object.keys(UX_AREAS));
    for (const e of CURATED_KNOWLEDGE) {
      expect(e.fonte_url?.startsWith("https://")).toBe(true);
      for (const a of e.areas) expect(areas.has(a)).toBe(true);
      expect(e.limitacoes.length).toBeGreaterThan(10);
      expect(e.evidencia.length).toBeGreaterThan(20);
    }
    expect(NEEDS_URL).toContain("estudo");
  });

  test("every curated entry has the source's literal excerpt (up to 300 characters)", () => {
    for (const e of CURATED_KNOWLEDGE) {
      expect(e.trecho?.trim().length ?? 0).toBeGreaterThan(10);
      expect((e.trecho ?? "").length).toBeLessThanOrEqual(300);
    }
  });

  test("covers the whole site: each page type has a study of its parts", () => {
    for (const t of [
      "home",
      "categoria",
      "busca",
      "carrinho_checkout",
    ] as const) {
      const parts: string[] = PAGE_TYPES[t].areas.filter(
        (a) => a !== "pagina_geral",
      );
      const hits = CURATED_KNOWLEDGE.filter((e) =>
        e.areas.some((a) => parts.includes(a)),
      );
      expect(hits.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("selectKnowledge per page", () => {
  test("a filter hypothesis brings the filter study before the whole-page wildcard", () => {
    const block = selectKnowledge({
      entries: CURATED_KNOWLEDGE,
      areas: ["filtros_ordenacao"],
      pageType: "categoria",
    });
    const first = [...block.byLabel.values()][0];
    expect(first!.areas).toContain("filtros_ordenacao");
  });

  test("the whole search page pulls the search parts, not the PDP's", () => {
    const block = selectKnowledge({
      entries: CURATED_KNOWLEDGE,
      areas: ["pagina_geral"],
      pageType: "busca",
    });
    const picked = [...block.byLabel.values()];
    expect(
      picked.some((e) =>
        e.areas.some((a) =>
          ["campo_busca", "resultados_busca", "busca_sem_resultado"].includes(
            a,
          ),
        ),
      ),
    ).toBe(true);
  });
});

describe("selectKnowledge", () => {
  test("only what applies to the parts in play; the store comes first", () => {
    const block = selectKnowledge({
      entries: [store({}), ...CURATED_KNOWLEDGE],
      areas: ["leve_o_look"],
    });
    const picked = [...block.byLabel.values()];
    expect(picked[0]!.id).toBe("s1");
    expect(block.text.startsWith("- [K1] A/B desta loja")).toBe(true);
    for (const e of picked) {
      expect(
        e.areas.some((a) => a === "leve_o_look" || a === "pagina_geral"),
      ).toBe(true);
    }
  });

  test("what the store learned gets in even from another part of the page, after the part's own", () => {
    const block = selectKnowledge({
      entries: [
        store({ id: "outra", areas: ["leve_o_look"], origem: "veredito" }),
        store({ id: "daqui", areas: ["tamanho"] }),
        ...CURATED_KNOWLEDGE,
      ],
      areas: ["tamanho"],
    });
    const ids = [...block.byLabel.values()].map((e) => e.id);
    expect(ids.slice(0, 2)).toEqual(["daqui", "outra"]);
  });

  test("disabled does not get in; the character budget cuts", () => {
    const off = selectKnowledge({
      entries: [store({ active: false })],
      areas: [],
    });
    expect(off.byLabel.size).toBe(0);
    expect(knowledgeForPrompt(off)).toBe("");
    const tight = selectKnowledge({
      entries: CURATED_KNOWLEDGE,
      areas: [],
      maxChars: 500,
    });
    expect(tight.byLabel.size).toBeLessThan(3);
  });

  test("one of each category before repeating a category", () => {
    const block = selectKnowledge({
      entries: CURATED_KNOWLEDGE,
      areas: [],
      maxCurated: 4,
      maxChars: 99_999,
    });
    const cats = [...block.byLabel.values()].map((e) => e.categoria);
    expect(new Set(cats).size).toBe(4);
  });

  test("a citation outside the block is discarded", () => {
    const block = selectKnowledge({ entries: [store({})], areas: [] });
    const got = resolveCitations(["[K1]", "k1", "K9", 3], block);
    expect(got.map((e) => e.id)).toEqual(["s1"]);
    expect(resolveCitations("K1", block)).toEqual([]);
  });
});

const hyp: UxHypothesis = {
  id: "d1:o1:h1",
  diagnosis_id: "d1234567-x",
  title: "O tamanho fica abaixo da primeira tela",
  idea: "Barra fixa",
  device: "mobile",
  status: "approved",
  status_note: null,
  updated_at: "2026-11-15T10:00:00Z",
} as UxHypothesis;

const verification = (
  verdict: HypothesisVerification["verdict"],
  stage: "live" | "repo" = "live",
): HypothesisVerification => ({
  verdict,
  summary: "o tamanho está em y=1272 numa tela de 844",
  runs: [
    {
      check: { stage } as never,
      outcome: verdict === "desmentida" ? "desmente" : "confirma",
      observed: "",
      screenshot_url: null,
      source_ref: null,
    },
  ],
  rewritten_from: null,
  verified_at: "2026-11-15T10:00:00Z",
});

describe("learning from the verifier", () => {
  test("confirmed becomes a condition, never a cause", () => {
    const d = fromVerification({
      hypothesis: hyp,
      area: "tamanho",
      verification: verification("confirmada"),
      pageUrl: "https://loja/p",
    });
    expect(d?.id).toBe("veredito:d1:o1:h1");
    expect(d?.conhecimento).toContain("A condição existe");
    expect(d?.limitacoes).toContain("não que ela causa");
    expect(d?.resultado).toBe("confirmada");
    expect(d?.confiabilidade).toBe("alta");
  });

  test("disproved and rewritten become refuted; code only = medium", () => {
    expect(
      fromVerification({
        hypothesis: hyp,
        area: "tamanho",
        verification: verification("desmentida", "repo"),
        pageUrl: null,
      }),
    ).toMatchObject({ resultado: "refutada", confiabilidade: "media" });
    expect(
      fromVerification({
        hypothesis: hyp,
        area: "tamanho",
        verification: verification("reescrita"),
        pageUrl: null,
      })?.resultado,
    ).toBe("refutada");
  });

  test("inconclusive teaches nothing", () => {
    expect(
      fromVerification({
        hypothesis: hyp,
        area: "tamanho",
        verification: verification("inconclusiva"),
        pageUrl: null,
      }),
    ).toBeNull();
  });
});

describe("learning from the decision", () => {
  test("discarded with a reason keeps the reason; pending does not record", () => {
    const d = fromDecision({
      hypothesis: hyp,
      area: "tamanho",
      status: "dismissed",
      note: "já testamos barra fixa em 2025",
      at: hyp.updated_at,
    });
    expect(d?.conhecimento).toContain("motivo: já testamos barra fixa");
    expect(d?.confiabilidade).toBe("media");
    expect(
      fromDecision({
        hypothesis: hyp,
        area: "tamanho",
        status: "pending",
        note: null,
        at: hyp.updated_at,
      }),
    ).toBeNull();
  });
});

describe("which parts the learning applies to", () => {
  test("the part the hypothesis targets comes first; the opportunity's stays with it", () => {
    const buy = {
      tree: { alvo: { kind: "part", key: "buy_button", label: "" } },
    } as never;
    expect(areasFor(buy, "navegacao")).toEqual(["botao_compra", "navegacao"]);
    const popup = {
      tree: { alvo: { kind: "section", key: "x", label: "" } },
    } as never;
    expect(areasFor(popup, "navegacao")).toEqual(["pagina_geral", "navegacao"]);
    expect(areasFor({ tree: null }, "tamanho")).toEqual(["tamanho"]);
    expect(areasFor(buy, "botao_compra")).toEqual(["botao_compra"]);
  });

  test("the stored verdict shows up when the analysis looks at the buy button", () => {
    const d = fromVerification({
      hypothesis: {
        ...hyp,
        tree: { alvo: { kind: "part", key: "buy_button", label: "" } },
      } as never,
      area: "navegacao",
      verification: verification("desmentida"),
      pageUrl: null,
    });
    const block = selectKnowledge({
      entries: [
        {
          ...(d as KnowledgeEntry),
          created_at: "",
          updated_at: new Date().toISOString(),
        },
      ],
      areas: ["botao_compra"],
    });
    expect(block.byLabel.size).toBe(1);
  });
});
