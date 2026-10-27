import { describe, expect, it } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import {
  blogBlockKind,
  blogBlockName,
  blogBlockTitle,
  blogKindWord,
} from "./blog-block-name";

const post = {
  name: "blog-manager/posts/b10900000001",
  __resolveType: "blog/loaders/Blogpost.ts",
  post: { title: "How capybaras dry off" },
};

describe("a blog record in words", () => {
  it("knows its kind by its key, live or planned, or by its copy", () => {
    expect(blogBlockKind("collections/blog/posts/abc")).toBe("post");
    expect(blogBlockKind("blog-manager/posts/abc")).toBe("post");
    expect(blogBlockKind("collections/blog/categories/c0ffee")).toBe(
      "category",
    );
    expect(blogBlockKind("collections/blog/authors/a1")).toBe("author");
    expect(blogBlockKind("Some Key", post)).toBe("post");
    expect(blogBlockKind("Footer", { name: "Footer" })).toBeNull();
    expect(blogBlockKind("blog-manager/campaigns/x")).toBeNull();
  });

  it("is named by its title, never its key", () => {
    expect(blogBlockTitle(post)).toBe("How capybaras dry off");
    expect(
      blogBlockTitle({ category: { name: "Rain care", slug: "rain-care" } }),
    ).toBe("Rain care");
    expect(blogBlockName("post", [post])).toBe("How capybaras dry off");
  });

  it("falls back to its kind, translated", () => {
    expect(blogBlockName("category", [{ category: {} }], (k) => en[k])).toBe(
      "Category",
    );
    expect(blogKindWord("author", (k) => ptBR[k])).toBe("Autor");
    expect(blogKindWord("category", (k) => ptBR[k])).toBe("Categoria");
  });
});
