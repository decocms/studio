import { describe, expect, test } from "bun:test";
import { appendFacts, type UxFact } from "./facts.ts";
import { triedLines, verdictFacts } from "./reinvestigate.ts";
import type { UxHypothesis } from "./types.ts";

const h = (over: Partial<UxHypothesis>): UxHypothesis =>
  ({
    id: "o1:h1",
    opportunity_id: "o1",
    kind: "proposta",
    title: "o comprar barra quem não escolheu tamanho",
    device: "mobile",
    verification: null,
    ...over,
  }) as UxHypothesis;

// A PDP where the code showed that "comprar" opens a drawer.
const refuted = h({
  verification: {
    verdict: "desmentida",
    summary: "o toque já abre uma gaveta com os tamanhos",
    runs: [],
    rewritten_from: null,
    verified_at: "2026-11-16T00:00:00Z",
    novas_linhas: ["olhar o que acontece depois de escolher o tamanho"],
  },
});

describe("what verification saw comes back as a fact", () => {
  test("only a refuted one becomes a fact; it is a reading (not measured), from the hypothesis's screen", () => {
    const facts = verdictFacts([refuted, h({ id: "o1:h2", title: "outra" })]);
    expect(facts).toEqual([
      {
        kind: "verificacao",
        source: "pagina",
        device: "mobile",
        measured: false,
        group:
          "Verificações desta análise: o que se testou na página e no código das causas que caíram",
        text: 'a verificação desmentiu "o comprar barra quem não escolheu tamanho": o toque já abre uma gaveta com os tamanhos (linhas abertas: olhar o que acontece depois de escolher o tamanho)',
      },
    ]);
  });

  test("the new fact goes at the end of the book, without touching old ids", () => {
    const old: UxFact[] = [
      {
        id: "F1",
        kind: "funil",
        source: "ga4",
        device: "mobile",
        measured: true,
        group: "g",
        text: "a",
      },
      {
        id: "F242",
        kind: "posicao",
        source: "pagina",
        device: "mobile",
        measured: true,
        group: "g",
        text: "b",
      },
    ];
    const out = appendFacts(old, verdictFacts([refuted]));
    expect(out.map((f) => f.id)).toEqual(["F1", "F242", "F243"]);
  });

  test("already tried: the refuted and the inconclusive, with the reason", () => {
    const inconclusive = h({
      id: "o1:h2",
      title: "as setas não respondem",
      verification: {
        ...refuted.verification!,
        verdict: "inconclusiva",
        summary: "o alvo está escondido no celular",
      },
    });
    expect(
      triedLines([refuted, inconclusive], ['"x" (triagem: sintoma)']),
    ).toEqual([
      '"o comprar barra quem não escolheu tamanho" — desmentida: o toque já abre uma gaveta com os tamanhos',
      '"as setas não respondem" — inconclusiva: o alvo está escondido no celular',
      '"x" (triagem: sintoma)',
    ]);
  });
});
