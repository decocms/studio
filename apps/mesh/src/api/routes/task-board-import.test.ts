import { describe, expect, it } from "bun:test";
import { importBodySchema } from "./task-board-import";

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
