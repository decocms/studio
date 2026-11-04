import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  applyBlogCardPatch,
  BLOG_POST_ID,
  type BlogCard,
  blogCardBranch,
  BlogCardPatchSchema,
  BlogCardSchema,
  mergeJsonPatch,
} from "./blog-card";

const CARD: BlogCard = {
  id: "aurora-1",
  kind: "blogpost",
  status: "ideas",
  virtualMcpId: "vmcp_1",
  campaignId: "camp_1",
  createdBy: "user_1",
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:00:00.000Z",
};

describe("BLOG_POST_ID", () => {
  test("letters, digits, dash and underscore, starting with a letter or digit", () => {
    expect(BLOG_POST_ID.test("aurora-1")).toBe(true);
    expect(BLOG_POST_ID.test("A_b-9")).toBe(true);
    expect(BLOG_POST_ID.test("x".repeat(64))).toBe(true);
  });

  test("refuses what cannot be a post key or a branch", () => {
    expect(BLOG_POST_ID.test("")).toBe(false);
    expect(BLOG_POST_ID.test("-leading")).toBe(false);
    expect(BLOG_POST_ID.test("has/slash")).toBe(false);
    expect(BLOG_POST_ID.test("has space")).toBe(false);
    expect(BLOG_POST_ID.test("x".repeat(65))).toBe(false);
  });
});

describe("BlogCardSchema", () => {
  test("keeps fields this version does not know, at every level", () => {
    const parsed = BlogCardSchema.parse({
      ...CARD,
      futureField: 1,
      hypothesis: {
        title: "Sofás para salas pequenas",
        evidence: [{ source: "gsc", fact: "Busca em alta", extra: true }],
        futureNested: "kept",
      },
      post: { title: "T", sections: [{ type: "Paragraph", align: "left" }] },
    });
    expect(parsed).toMatchObject({
      futureField: 1,
      hypothesis: {
        futureNested: "kept",
        evidence: [{ extra: true }],
      },
      post: { sections: [{ align: "left" }] },
    });
  });

  test("carries the post's objective beside the metric that measures it", () => {
    const objective =
      "Trazer 1.500 sessões orgânicas por mês para mochilas, parte dos +20% da campanha.";
    const parsed = BlogCardSchema.parse({
      ...CARD,
      hypothesis: { objective, metric: "Sessões orgânicas em /mochilas" },
    });
    expect(parsed.hypothesis?.objective).toBe(objective);
    expect(
      BlogCardSchema.safeParse({
        ...CARD,
        hypothesis: { objective: "x".repeat(601) },
      }).success,
    ).toBe(false);
  });

  test("refuses an unknown status or evidence source", () => {
    expect(BlogCardSchema.safeParse({ ...CARD, status: "done" }).success).toBe(
      false,
    );
    expect(
      BlogCardSchema.safeParse({
        ...CARD,
        hypothesis: { evidence: [{ source: "twitter", fact: "x" }] },
      }).success,
    ).toBe(false);
  });

  test("carries a figure's detail, and refuses one that cannot be drawn", () => {
    const detail = {
      trend: { points: [3100, 3400, 3900], label: "impressões por semana" },
      stats: [{ label: "Cliques", value: "0" }],
      compare: [
        { label: "Malas", value: 2.1, display: "2,1%" },
        { label: "Site", value: 1, display: "1,0%" },
      ],
      products: [
        {
          name: "Mala de bordo",
          note: "R$ 499",
          image: "https://img.example/m.jpg",
        },
      ],
      timeline: [
        { date: "2026-11-03", label: "Hoje", now: true },
        { date: "2026-11-27", label: "Black Friday" },
      ],
      link: { url: "https://analytics.google.com/analytics/web/" },
    };
    const parsed = BlogCardSchema.parse({
      ...CARD,
      hypothesis: { evidence: [{ source: "ga4", fact: "Converte", detail }] },
    });
    expect(parsed.hypothesis?.evidence?.[0]?.detail).toEqual(detail);

    const refused = (bad: Record<string, unknown>) =>
      BlogCardSchema.safeParse({
        ...CARD,
        hypothesis: { evidence: [{ source: "ga4", fact: "x", detail: bad }] },
      }).success;
    expect(refused({ trend: { points: [1] } })).toBe(false);
    expect(refused({ compare: [{ label: "a", value: 1, display: "1" }] })).toBe(
      false,
    );
    expect(refused({ link: { url: "http://example.com" } })).toBe(false);
    expect(
      refused({ products: [{ name: "x", image: "javascript:alert(1)" }] }),
    ).toBe(false);
    expect(
      refused({
        stats: Array.from({ length: 5 }, (_, i) => ({
          label: `s${i}`,
          value: "1",
        })),
      }),
    ).toBe(false);
  });

  test("converts to JSON Schema, as a tool's output must", () => {
    expect(() => z.toJSONSchema(BlogCardSchema)).not.toThrow();
    expect(() => z.toJSONSchema(BlogCardPatchSchema)).not.toThrow();
  });
});

describe("BlogCardPatchSchema", () => {
  test("refuses the fields the server owns", () => {
    for (const field of [
      "id",
      "kind",
      "threadId",
      "branch",
      "run",
      "createdBy",
      "createdAt",
      "updatedAt",
    ]) {
      expect(BlogCardPatchSchema.safeParse({ [field]: "x" }).success).toBe(
        false,
      );
    }
  });

  test("takes null to remove a field, but never the site", () => {
    expect(BlogCardPatchSchema.safeParse({ error: null }).success).toBe(true);
    expect(BlogCardPatchSchema.safeParse({ virtualMcpId: null }).success).toBe(
      false,
    );
  });

  test("an empty patch is a valid no-op", () => {
    expect(BlogCardPatchSchema.safeParse({}).success).toBe(true);
  });
});

describe("applyBlogCardPatch", () => {
  const NOW = "2026-10-28T11:00:00.000Z";

  test("merges objects key by key and moves updatedAt", () => {
    const card = {
      ...CARD,
      hypothesis: { title: "Antes", metric: "Cliques" },
    };
    const next = applyBlogCardPatch(
      card,
      { hypothesis: { title: "Depois" } },
      NOW,
    );
    expect(next.hypothesis).toEqual({ title: "Depois", metric: "Cliques" });
    expect(next.updatedAt).toBe(NOW);
    expect(card.hypothesis.title).toBe("Antes");
  });

  test("replaces arrays whole", () => {
    const card = {
      ...CARD,
      hypothesis: { keywords: [{ term: "a" }, { term: "b" }] },
    };
    const next = applyBlogCardPatch(
      card,
      { hypothesis: { keywords: [{ term: "c" }] } },
      NOW,
    );
    expect(next.hypothesis?.keywords).toEqual([{ term: "c" }]);
  });

  test("a new format replaces the last one whole, its length included", () => {
    const next = applyBlogCardPatch(
      {
        ...CARD,
        hypothesis: {
          title: "Guia",
          format: {
            id: "guia",
            name: "Guia",
            value: "…",
            length: "1.500 palavras",
          },
        },
      },
      {
        hypothesis: { format: { id: "lista", name: "Lista", value: "Itens." } },
      },
      NOW,
    );
    expect(next.hypothesis?.title).toBe("Guia");
    expect(Object.keys(next.hypothesis?.format ?? {}).sort()).toEqual([
      "id",
      "name",
      "value",
    ]);
    expect(next.hypothesis?.format.name).toBe("Lista");
  });

  test("null removes a field", () => {
    const next = applyBlogCardPatch(
      { ...CARD, error: "timeout" },
      { error: null },
      NOW,
    );
    expect("error" in next).toBe(false);
  });

  test("keeps what the patch does not name, unknown fields included", () => {
    const next = applyBlogCardPatch(
      { ...CARD, futureField: 1 },
      { status: "awaiting_review" },
      NOW,
    );
    expect(next).toMatchObject({
      futureField: 1,
      status: "awaiting_review",
      campaignId: "camp_1",
    });
  });
});

describe("blogCardBranch", () => {
  test("is flat", () => {
    expect(blogCardBranch("aurora-1")).toBe("blog-aurora-1");
    expect(blogCardBranch("aurora-1")).not.toContain("/");
  });
});

describe("mergeJsonPatch", () => {
  test("objects merge, arrays replace, null removes", () => {
    expect(
      mergeJsonPatch(
        { a: { b: 1, c: 2 }, list: [1, 2], gone: "x" },
        { a: { c: 3 }, list: [9], gone: null },
      ),
    ).toEqual({ a: { b: 1, c: 3 }, list: [9] });
  });
});
