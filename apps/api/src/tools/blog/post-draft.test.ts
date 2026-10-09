import { describe, expect, test } from "bun:test";
import { describeGaps, productReference, renderCampaign } from "./post-draft";

const RUN = {
  grounded: true,
  droppedSections: 0,
  failedDrafts: 0,
  images: "ok" as const,
  covered: 1,
};

describe("describeGaps", () => {
  test("says nothing when everything worked", () => {
    expect(describeGaps(RUN)).toEqual([]);
  });

  test("a store that answered nothing is its own gap", () => {
    expect(describeGaps({ ...RUN, grounded: false })).toEqual([
      { code: "no-store-data" },
    ]);
  });

  test("counts the sections a block refused to accept", () => {
    expect(describeGaps({ ...RUN, droppedSections: 3 })).toEqual([
      { code: "sections-dropped", count: 3 },
    ]);
  });

  test("counts the drafts that were asked for and never arrived", () => {
    expect(describeGaps({ ...RUN, failedDrafts: 2 })).toEqual([
      { code: "drafts-failed", count: 2 },
    ]);
  });

  test("tells a missing bucket apart from a missing image model", () => {
    expect(describeGaps({ ...RUN, images: "no-bucket", covered: 0 })).toEqual([
      { code: "no-bucket" },
    ]);
    expect(describeGaps({ ...RUN, images: "no-model", covered: 0 })).toEqual([
      { code: "no-image-model" },
    ]);
  });

  /**
   * One image failing out of three is not a story worth telling — the posts
   * that did get a cover are the evidence that the bucket and the model work.
   */
  test("only reports failed images when none at all were made", () => {
    expect(describeGaps({ ...RUN, images: "failed", covered: 2 })).toEqual([]);
    expect(describeGaps({ ...RUN, images: "failed", covered: 0 })).toEqual([
      { code: "images-failed" },
    ]);
  });
});

describe("renderCampaign", () => {
  const campaign = {
    name: "Volta às Aulas",
    period: { start: "2027-01-05", end: null },
    trigger: { type: "seasonal" as const, note: "Janeiro move mochila." },
    intent: {
      objective: "conversion" as const,
      targets: [
        {
          kind: "category",
          name: "Escolar",
          url: "https://loja.com.br/escolar",
          description: "",
        },
      ],
      products: [
        {
          name: "Mochila Frozen",
          url: "https://loja.com.br/frozen/p",
          images: ["https://cdn/a.jpg"],
          category: "Escolar",
          description: "Licenciada.",
        },
      ],
      keywords: ["mochila escolar"],
    },
    guardrails: { avoidComplements: [], toneOverrides: "" },
  };

  test("carries the product's link and image address through verbatim", () => {
    const rendered = renderCampaign(campaign);
    expect(rendered).toContain("https://loja.com.br/frozen/p");
    expect(rendered).toContain("https://cdn/a.jpg");
  });

  test("says when the campaign runs, and that it has no end", () => {
    expect(renderCampaign(campaign)).toContain("2027-01-05");
    expect(renderCampaign(campaign)).toContain("no fixed end");
  });

  test("leaves out the sections a campaign has nothing for", () => {
    const bare = renderCampaign({
      ...campaign,
      period: { start: null, end: null },
      intent: { ...campaign.intent, targets: [], products: [], keywords: [] },
    });
    expect(bare).not.toContain("Products this post may name");
    expect(bare).not.toContain("What it argues for");
    expect(bare).not.toContain("Runs");
  });

  test("a campaign-only guardrail is marked as on top of the brand's", () => {
    const rendered = renderCampaign({
      ...campaign,
      guardrails: {
        avoidComplements: [{ name: "Preço", value: "Nunca cite preço." }],
        toneOverrides: "",
      },
    });
    expect(rendered).toContain("on top of the brand's");
    expect(rendered).toContain("Nunca cite preço.");
  });
});

/**
 * A product field on a section holds a handle a loader resolves, and the
 * campaign carries no id a loader would take — what the catalogue reported is
 * a stock code, not what the storefront indexes by. The address is the handle.
 */
describe("productReference", () => {
  test("takes the slug out of a product page address", () => {
    expect(productReference("https://loja.com.br/mochila-frozen-shine/p")).toBe(
      "mochila-frozen-shine",
    );
  });

  test("handles an address that is not a /p page", () => {
    expect(productReference("https://loja.com.br/escolar/mochila-azul")).toBe(
      "mochila-azul",
    );
  });

  test("ignores a query string and a trailing slash", () => {
    expect(
      productReference("https://loja.com.br/mochila-frozen/p/?skuId=148129"),
    ).toBe("mochila-frozen");
  });

  test("answers nothing for a product the campaign could not link", () => {
    expect(productReference("")).toBe("");
    expect(productReference("not a url")).toBe("");
  });

  test("answers nothing for an address with no path to speak of", () => {
    expect(productReference("https://loja.com.br/")).toBe("");
  });
});

describe("renderCampaign — product references", () => {
  const withProduct = (url: string) => ({
    name: "C",
    period: { start: null, end: null },
    trigger: { type: "launch" as const, note: "n" },
    intent: {
      objective: "conversion" as const,
      targets: [],
      products: [
        {
          name: "Mochila Frozen",
          url,
          images: [],
          category: "",
          description: "",
        },
      ],
      keywords: [],
    },
    guardrails: { avoidComplements: [], toneOverrides: "" },
  });

  test("gives each product the reference a block can point at", () => {
    expect(
      renderCampaign(withProduct("https://loja.com.br/mochila-frozen/p")),
    ).toContain("reference: mochila-frozen");
  });

  test("says nothing where there is no address to take one from", () => {
    expect(renderCampaign(withProduct(""))).not.toContain("reference:");
  });
});
