import { describe, expect, test } from "bun:test";
import { type Draft, publishedPayload } from "./card-publishing";

const POST = {
  title: "Mala de bordo na Black Friday",
  slug: "mala-de-bordo",
  image: "https://cdn.example/old.png",
  alt: "Mala",
  seo: { title: "", description: "", image: "https://cdn.example/old.png" },
  status: "draft",
};

const draft = (over: Partial<Draft>): Draft => ({
  slug: POST.slug,
  goLive: null,
  image: POST.image,
  alt: POST.alt,
  seoTitle: "",
  seoDescription: "",
  ...over,
});

describe("publishedPayload", () => {
  test("normalizes the slug and numbers it past one another post owns", () => {
    const own = publishedPayload(POST, draft({ slug: "Mala de Bordô!" }), []);
    expect(own.payload.slug).toBe("mala-de-bordo");
    expect(own.renamed).toBe(false);
    const taken = publishedPayload(POST, draft({ slug: "guia" }), ["guia"]);
    expect(taken.payload.slug).not.toBe("guia");
    expect(taken.renamed).toBe(true);
  });

  test("a picked go-live date sets the schedule and the post's date; none leaves both", () => {
    const picked = publishedPayload(
      POST,
      draft({ goLive: "2026-11-12T09:00" }),
      [],
    ).payload;
    expect(typeof picked.scheduledDatetime).toBe("string");
    expect(picked.date).toBe(String(picked.scheduledDatetime).slice(0, 10));
    const untouched = publishedPayload(POST, draft({}), []).payload;
    expect("scheduledDatetime" in untouched).toBe(false);
    expect("date" in untouched).toBe(false);
  });

  test("the search image follows a new cover, unless someone set it apart", () => {
    const cover = "https://cdn.example/new.png";
    const follows = publishedPayload(POST, draft({ image: cover }), []).payload;
    expect((follows.seo as Record<string, unknown>).image).toBe(cover);
    const apart = publishedPayload(
      { ...POST, seo: { image: "https://cdn.example/social.png" } },
      draft({ image: cover }),
      [],
    ).payload;
    expect((apart.seo as Record<string, unknown>).image).toBe(
      "https://cdn.example/social.png",
    );
  });

  test("keeps what it does not edit, and stamps the change", () => {
    const next = publishedPayload(
      POST,
      draft({ seoTitle: "Título", alt: "Nova" }),
      [],
    ).payload;
    expect(next.title).toBe(POST.title);
    expect(next.status).toBe("draft");
    expect(next.alt).toBe("Nova");
    expect((next.seo as Record<string, unknown>).title).toBe("Título");
    expect(typeof next.dateModified).toBe("string");
  });
});
