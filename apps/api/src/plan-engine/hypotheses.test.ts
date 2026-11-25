import { describe, expect, test } from "bun:test";
import { evidence as makeEvidence } from "./fixtures/evidence.ts";
import {
  describeElementLabel,
  elementsForPrompt,
  foldNote,
} from "./hypotheses.ts";
import type { DevicePdpBehaviour, PageCapture } from "./types.ts";

describe("foldNote", () => {
  test("diz se a parte está na 1ª tela, pela altura da tela", () => {
    expect(foldNote(699, 844)).toBe("699px (na 1ª tela, que vai até 844px)");
    expect(foldNote(1200, 844)).toBe(
      "1200px (abaixo da 1ª tela: 356px de rolagem)",
    );
    expect(foldNote(null, 844)).toBe("não achado");
  });
});

describe("tabela de elementos: o que o elemento faz (busca de uma loja de moda, 16/11)", () => {
  const b = {
    device: "mobile",
    views: 307_883,
    clicks: 667_993,
    dead_clicks: 58_798,
    funnel: { visitors: 203_299, viewed: 65_395, carted: 17_982 },
    sections: [],
    elements: [
      {
        root: "h",
        el: "submit",
        section: "Header/Header",
        clicks: 22_663,
        dead: 12_705,
        dead_interactive: 12_705,
        funnel: { visitors: 15_329, carted: 3_541 },
      },
      {
        root: "h",
        el: "open",
        section: "Header/Header",
        clicks: 23_124,
        dead: 19,
        dead_interactive: 19,
        funnel: { visitors: 19_041, carted: 4_280 },
      },
    ],
  } as unknown as DevicePdpBehaviour;
  const ev = makeEvidence({
    captures: [
      {
        device: "mobile",
        element_labels: {
          "h|submit": {
            label: 'button "Search term"',
            y: 0,
            navigates: "/buscar",
            hidden: true,
          },
          "h|open": { label: 'label "open search"', y: 40 },
        },
      } as unknown as PageCapture,
    ],
  });

  test("o envio diz pra onde leva e que o morto é a página demorando", () => {
    const [submit, open] = elementsForPrompt(ev, b);
    expect(submit).toContain('button "Search term" → leva pra /buscar');
    expect(submit).toContain("escondido na carga");
    expect(submit).not.toContain("y=0");
    expect(submit).toContain("mortos 56.1% (troca de página");
    // A lupa muda a própria página: o morto fica sem ressalva.
    expect(open).toContain('label "open search" (y=40px)');
    expect(open).not.toContain("troca de página");
  });

  test("describeElementLabel: elemento comum fica como era", () => {
    expect(describeElementLabel({ label: 'button "comprar"', y: 900 })).toBe(
      'button "comprar" (y=900px)',
    );
  });
});
