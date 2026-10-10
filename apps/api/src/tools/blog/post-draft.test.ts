import { describe, expect, test } from "bun:test";
import { describeGaps, renderCampaign } from "./post-draft";

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
          id: "148129",
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
 * A product block points at a product by the id the storefront indexes it by.
 * The campaign is the only place that id comes from — composing one is how a
 * card ends up showing nothing.
 */
describe("renderCampaign — the product's id", () => {
  const withProduct = (id: string) => ({
    name: "C",
    period: { start: null, end: null },
    trigger: { type: "launch" as const, note: "n" },
    intent: {
      objective: "conversion" as const,
      targets: [],
      products: [
        {
          id,
          name: "Mochila Frozen",
          url: "https://loja.com.br/mochila-frozen/p",
          images: [],
          category: "",
          description: "",
        },
      ],
      keywords: [],
    },
    guardrails: { avoidComplements: [], toneOverrides: "" },
  });

  test("gives each product the id a block points at", () => {
    expect(renderCampaign(withProduct("1948858"))).toContain("id: 1948858");
  });

  test("says nothing where the catalogue reported no id", () => {
    expect(renderCampaign(withProduct(""))).not.toContain("id:");
  });

  test("still carries the link and the name alongside it", () => {
    const rendered = renderCampaign(withProduct("1948858"));
    expect(rendered).toContain("https://loja.com.br/mochila-frozen/p");
    expect(rendered).toContain("Mochila Frozen");
  });
});
