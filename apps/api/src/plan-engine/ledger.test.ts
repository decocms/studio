import { describe, expect, test } from "bun:test";
import type { KnowledgeEntry } from "./knowledge/types.ts";
import { heldRefutations, priorRefutations } from "./ledger.ts";
import type { HypothesisTree } from "./tree.ts";
import type { UxHypothesis } from "./types.ts";

const verdict = (over: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id: "veredito:d1:o1:h1",
  conhecimento: "Não é o caso nesta loja: tamanho escondido",
  categoria: "ux",
  fonte: "Verificador do diagnóstico d1",
  fonte_url: null,
  tipo_fonte: "veredito_desta_loja",
  contexto: "",
  areas: ["tamanho"],
  evidencia: "c1 mediu o seletor na 1ª tela",
  confiabilidade: "alta",
  limitacoes: "",
  resultado: "refutada",
  origem: "veredito",
  diagnosis_id: "d1",
  hypothesis_id: "d1:o1:h1",
  assinatura: "pdp|mobile|abc",
  active: true,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});

const tree = (part: string): HypothesisTree =>
  ({
    category: "ux",
    alvo: { kind: "part", key: part, label: part },
    metrica: { key: "produto_carrinho" },
    a_favor: [],
    contra: [],
  }) as unknown as HypothesisTree;

describe("heldRefutations", () => {
  test("keeps a refuted verdict of this page type from another round", () => {
    expect(heldRefutations([verdict()], "pdp", "d2")).toHaveLength(1);
  });

  test("drops what no longer holds or does not apply", () => {
    const out = heldRefutations(
      [
        verdict({ stale: true }),
        verdict({ active: false }),
        verdict({ resultado: "confirmada" }),
        verdict({ origem: "decisao" }),
        verdict({ assinatura: "home|mobile|abc" }),
        verdict({ assinatura: null }),
        verdict({ hypothesis_id: null }),
        verdict({ diagnosis_id: "d2" }),
      ],
      "pdp",
      "d2",
    );
    expect(out).toEqual([]);
  });
});

describe("priorRefutations", () => {
  test("keys each refuted cause by target and step; a missing or untargeted hypothesis is skipped", () => {
    const hs = [
      {
        id: "d1:o1:h1",
        title: "Tamanho escondido",
        tree: tree("size_selector"),
      },
      { id: "d1:o1:h2", title: "Sem alvo", tree: { ...tree("x"), alvo: null } },
    ] as Array<Pick<UxHypothesis, "id" | "title" | "tree">>;
    const out = priorRefutations(
      [
        verdict(),
        verdict({ id: "v2", hypothesis_id: "d1:o1:h2" }),
        verdict({ id: "v3", hypothesis_id: "gone" }),
      ],
      hs,
    );
    expect([...out.entries()]).toEqual([
      [
        "ux|part:size_selector|produto_carrinho",
        {
          title: "Tamanho escondido",
          why: "c1 mediu o seletor na 1ª tela",
          diagnosisId: "d1",
        },
      ],
    ]);
  });
});
