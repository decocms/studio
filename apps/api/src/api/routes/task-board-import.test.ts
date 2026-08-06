import { describe, expect, it } from "bun:test";
import { importBodySchema, normalizeTitleKey } from "./task-board-import";

describe("importBodySchema", () => {
  it("accepts a minimal batch and fills nothing in", () => {
    const parsed = importBodySchema.safeParse({
      items: [{ title: "Adicionar H1 na home" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts description, priority, externalKey and source", () => {
    const parsed = importBodySchema.safeParse({
      items: [
        {
          title: "Liberar o GPTBot no WAF",
          description: "Crawlers de IA recebem 403.",
          priority: "high",
          externalKey: "diag:shop.com:GEO-001",
        },
      ],
      source: { url: "shop.com", run_id: "run_1" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty externalKey", () => {
    expect(
      importBodySchema.safeParse({
        items: [{ title: "t", externalKey: "" }],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty batch, an empty title and an unknown priority", () => {
    expect(importBodySchema.safeParse({ items: [] }).success).toBe(false);
    expect(importBodySchema.safeParse({ items: [{ title: "" }] }).success).toBe(
      false,
    );
    expect(
      importBodySchema.safeParse({
        items: [{ title: "t", priority: "blocker" }],
      }).success,
    ).toBe(false);
  });

  it("caps the batch at 100 items", () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      title: `t${i}`,
    }));
    expect(importBodySchema.safeParse({ items }).success).toBe(false);
    expect(
      importBodySchema.safeParse({ items: items.slice(0, 100) }).success,
    ).toBe(true);
  });
});

// The fallback finding identity for producers that send no `externalKey` — the
// case that let one board accumulate 19 cards for 8 findings, each duplicate
// spawning its own agent run and its own pull request.
describe("normalizeTitleKey", () => {
  it("flattens case and whitespace differences", () => {
    expect(normalizeTitleKey("  Adicionar um H1 na home  ")).toBe(
      normalizeTitleKey("adicionar um h1 na home"),
    );
    expect(normalizeTitleKey("Adicionar   um\tH1\nna home")).toBe(
      "adicionar um h1 na home",
    );
  });

  it("keeps genuinely different findings apart", () => {
    // Two real findings off the same board. They differ by a few words and are
    // NOT the same check — merging them would silently drop one, which is why
    // the match is exact rather than fuzzy.
    expect(
      normalizeTitleKey(
        "Habilitar compressão gzip ou brotli no servidor para respostas de texto",
      ),
    ).not.toBe(
      normalizeTitleKey(
        "Habilitar compressão gzip ou brotli nas respostas de texto da home",
      ),
    );
  });

  it("does not collapse distinct URLs in a title", () => {
    expect(normalizeTitleKey("Adicionar alt à imagem em /a.png")).not.toBe(
      normalizeTitleKey("Adicionar alt à imagem em /b.png"),
    );
  });
});
