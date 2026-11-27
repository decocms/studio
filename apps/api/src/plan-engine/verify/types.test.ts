import { describe, expect, test } from "bun:test";
import {
  decodeVerification,
  encodeVerification,
  type HypothesisVerification,
} from "./types.ts";

const v: HypothesisVerification = {
  verdict: "confirmada",
  summary: "c1 mostrou o botão abaixo da dobra",
  runs: [
    {
      check: {
        id: "c1",
        claim: "o botão de compra some no celular",
        stage: "live",
        device: "mobile",
        steps: [
          { op: "open" },
          { op: "wait", ms: 500 },
          { op: "inspect", target: { kind: "part", part: "buy_button" } },
        ],
        question: null,
        confirms_if: "o botão fica abaixo da dobra",
        refutes_if: "o botão aparece na primeira tela",
      },
      outcome: "confirma",
      observed: "botão a 912px, dobra em 740px",
      screenshot_url: "https://r2.example/c1.png",
      source_ref: null,
    },
    {
      check: {
        id: "c1-f",
        claim: "o componente não é fixo",
        stage: "repo",
        device: "mobile",
        steps: [],
        question: "o botão usa position: sticky?",
        confirms_if: "não usa",
        refutes_if: "usa",
      },
      outcome: "nao_decidiu",
      observed: "não achei o arquivo",
      screenshot_url: null,
      source_ref: "src/sections/Product/ProductDetails.tsx:88",
    },
  ],
  rewritten_from: { title: "Título antigo", why: "porque sim" },
  verified_at: "2026-11-13T12:00:00.000Z",
};

describe("verification codec", () => {
  test("round trip returns the same object", () => {
    expect(decodeVerification(encodeVerification(v))).toEqual(v);
  });
  test("base_confidence round-trips; absent or invalid disappears", () => {
    const withBase = { ...v, base_confidence: 0.5 };
    expect(decodeVerification(encodeVerification(withBase))).toEqual(withBase);
    expect(decodeVerification(encodeVerification(v))?.base_confidence).toBe(
      undefined,
    );
    expect(
      decodeVerification(JSON.stringify({ ...v, base_confidence: "alta" })),
    ).toEqual(v);
  });
  test("strength round-trips; an unknown one disappears", () => {
    const strong = { ...v, strength: "corroborada" as const };
    expect(decodeVerification(encodeVerification(strong))).toEqual(strong);
    expect(
      decodeVerification(JSON.stringify({ ...v, strength: "forte" })),
    ).toEqual(v);
  });
  test("encode of null is null", () => {
    expect(encodeVerification(null)).toBeNull();
  });
  test("invalid JSON, null and an unknown verdict become null", () => {
    expect(decodeVerification("{")).toBeNull();
    expect(decodeVerification(null)).toBeNull();
    expect(decodeVerification('{"verdict":"talvez"}')).toBeNull();
  });
});
