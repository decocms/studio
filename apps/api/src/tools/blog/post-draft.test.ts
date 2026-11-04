import { describe, expect, test } from "bun:test";
import { agentWritingBrief, renderCampaign } from "./post-draft";

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

  test("states the campaign's goals, each with what counts it and how far", () => {
    const rendered = renderCampaign({
      ...campaign,
      goals: [
        {
          text: "Crescer o tráfego orgânico em acessórios",
          metric: "organic_sessions",
          target: "+20%",
        },
        { text: "Ser lembrada na volta às aulas", metric: null, target: "" },
      ],
    });
    expect(rendered).toContain(
      "Goals: Crescer o tráfego orgânico em acessórios (+20% organic sessions); Ser lembrada na volta às aulas.",
    );
  });

  test("the single goal an older campaign kept is still stated", () => {
    const rendered = renderCampaign({
      ...campaign,
      goal: {
        text: "Ser lembrada na volta às aulas",
        metric: null,
        target: "",
      },
    });
    expect(rendered).toContain("Goals: Ser lembrada na volta às aulas.");
  });

  test("empty goals, or none, say nothing about goals", () => {
    expect(renderCampaign(campaign)).not.toContain("Goals:");
    expect(
      renderCampaign({
        ...campaign,
        goals: [{ text: "  ", metric: "sessions", target: "+5%" }],
      }),
    ).not.toContain("Goals:");
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

describe("agentWritingBrief", () => {
  const input = {
    brand: {
      companyName: "Aurora",
      description: "Malas de viagem.",
      language: "pt-BR",
      tone: "Direto, sem exagero.",
      targetAudience: "Quem viaja de avião.",
      dos: [{ name: "Fale com o leitor como você", value: "" }],
      avoid: [{ name: "Promessas exageradas", value: "" }],
    },
    campaign: {
      name: "Férias de verão",
      period: { start: null, end: null },
      trigger: { type: "seasonal" as const, note: "Dezembro a fevereiro." },
      intent: {
        objective: "conversion" as const,
        targets: [],
        products: [],
        keywords: ["mala de bordo"],
      },
      guardrails: { avoidComplements: [], toneOverrides: "" },
    },
    format: { name: "Guia de escolha", value: "Abre com a dúvida do leitor." },
    blocks: [
      {
        name: "Paragraph",
        title: "Parágrafo",
        description: "",
        schema: { type: "object", properties: { html: { type: "string" } } },
      },
    ],
    exemplars: [],
    categories: [],
    authors: [],
  };

  test("carries the drafting rules, the post's reading and the answer's shape", () => {
    const brief = agentWritingBrief(
      input,
      "VTEX: 1.240 buscas por 'mala de bordo'.",
    );
    expect(brief).toContain("NEVER INVENT A VERIFIABLE FACT");
    expect(brief).toContain("## The campaign: Férias de verão");
    expect(brief).toContain("### Paragraph");
    expect(brief).toContain("1.240 buscas");
    expect(brief).toContain("`props` is an object here, not a string.");
  });

  test("states how long a post in the format runs, when the format says", () => {
    expect(
      agentWritingBrief(
        {
          ...input,
          format: { ...input.format, length: "1.200–1.800 palavras" },
        },
        "",
      ),
    ).toContain("## Format: Guia de escolha\nLength: 1.200–1.800 palavras");
    expect(agentWritingBrief(input, "")).not.toContain("Length:");
  });

  test("states how the brand fills its blocks before the blocks themselves", () => {
    const brief = agentWritingBrief(
      {
        ...input,
        brand: {
          ...input.brand,
          blocks: [
            {
              name: "@Heading",
              value: '`{"level":"h2"}` para seção; `"h3"` para pergunta.',
            },
          ],
        },
      },
      "",
    );
    const notes = brief.indexOf("## How this brand fills its blocks");
    expect(notes).toBeGreaterThan(-1);
    expect(brief).toContain('- @Heading: `{"level":"h2"}` para seção');
    expect(notes).toBeLessThan(brief.indexOf("## Blocks available"));
    expect(agentWritingBrief(input, "")).not.toContain(
      "## How this brand fills its blocks",
    );
  });

  test("shows the brand's own post in the format, and its commercial policies", () => {
    const brief = agentWritingBrief(
      {
        ...input,
        brand: {
          ...input.brand,
          commercialPolicies: [
            { name: "Retirada na loja", value: "grátis, em 200 lojas." },
          ],
        },
        exemplars: [
          {
            title: "Mala de bordo: medidas",
            slug: "mala-de-bordo-medidas",
            text: "## Medidas\n\nAté 55 x 35 x 25 cm.",
          },
        ],
      },
      "",
    );
    expect(brief).toContain(
      "### Mala de bordo: medidas (mala-de-bordo-medidas)\n## Medidas",
    );
    expect(brief).toContain("- Retirada na loja: grátis, em 200 lojas.");
    expect(agentWritingBrief(input, "")).not.toContain(
      "## How this brand writes a post like this",
    );
  });

  test("leaves the store section out when nothing was gathered", () => {
    expect(agentWritingBrief(input, "  ")).not.toContain(
      "What this brand's own systems report",
    );
  });

  test("refuses a brand a post would read generic from", () => {
    expect(() =>
      agentWritingBrief({ ...input, brand: { ...input.brand, tone: "" } }, ""),
    ).toThrow("fill tone");
  });
});
