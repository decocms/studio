import { describe, expect, test } from "bun:test";
import { parseReviews, REVIEW_SYSTEM } from "./review.ts";

describe("parseReviews", () => {
  test("only requested ids and valid answers; accents do not get in the way", () => {
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

  test("an unreadable answer reviews nothing", () => {
    expect(parseReviews("nada de json", ["h1"], "t").size).toBe(0);
  });

  test("the prompt asks the cause question", () => {
    expect(REVIEW_SYSTEM).toContain("EXPLICA a perda de conversão");
  });
});
