import { describe, expect, test } from "bun:test";
import { parseReviews, REVIEW_SYSTEM } from "./review.ts";

describe("parseReviews", () => {
  test("só ids pedidos e respostas válidas; acento não atrapalha", () => {
    const out = parseReviews(
      JSON.stringify({
        reviews: [
          {
            id: "h1",
            explica_o_gap: "Não",
            resposta: "só condição",
            falhas: ["a", "", "b", "c", "d"],
          },
          { id: "h2", explica_o_gap: "talvez", resposta: "x" },
          { id: "inventado", explica_o_gap: "sim", resposta: "x" },
        ],
      }),
      ["h1", "h2"],
      "t",
    );
    expect([...out.keys()]).toEqual(["h1"]);
    expect(out.get("h1")).toEqual({
      explica_o_gap: "nao",
      resposta: "só condição",
      falhas: ["a", "b", "c"],
      reviewed_at: "t",
    });
  });

  test("resposta ilegível não revisa nada", () => {
    expect(parseReviews("nada de json", ["h1"], "t").size).toBe(0);
  });

  test("o prompt faz a pergunta da causa", () => {
    expect(REVIEW_SYSTEM).toContain("EXPLICA a perda de conversão");
  });
});
