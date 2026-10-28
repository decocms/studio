import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  brandForBlog,
  doDont,
  formatsFrom,
  listItems,
  ruleFromItem,
  voiceExamples,
} from "./brand-blog";

const GUIDE = `---
name: Aurora Casa
description: Móveis e decoração com cara de casa de verdade.
language: pt-BR
site: https://aurora.example
---

# Aurora Casa

> Casa é onde a vida acontece.

## Tom de voz

Próximo, calmo e direto. Falamos "você", nunca "o cliente".

## Público

Quem está montando a primeira casa, entre 25 e 40 anos.

## Frases de exemplo

### Soa como a marca

- "Seu sofá, do seu jeito."
- "Entrega montada, sem dor de cabeça."

### Não soa como ela

- "COMPRE JÁ!!!"

## Regras

- **Preço** — nunca em bloco de texto; use o card de produto.
- Frases curtas.

## Vocabulário

- **Montagem**: sempre "montagem", nunca "instalação".

## Do / Don't

- ✅ Mostrar o produto em uso.
- ❌ Urgência falsa.
- ❌ **Jargão** — "sinergia", "alavancar".

## Valores

- **Durabilidade** — móveis feitos pra durar dez anos.

## Concorrentes

- **Loja Exemplo**: preço baixo, sem montagem.

## Palavras-chave

- sofá retrátil, mesa de jantar
- tapete

## Datas especiais

- **Dia das Mães** — maio.

## Políticas comerciais

- Frete grátis acima de R$ 299.

## Formatos de post

### Guia prático

Ensina a resolver um problema da casa passo a passo, citando @ProductShelf
quando o produto resolve.

### Lista

Cinco a dez itens numerados.

## Concept

Something the blog does not read.
`;

describe("brandForBlog", () => {
  const { brand, context, formats } = brandForBlog(GUIDE, "aurora");

  test("identity comes from the frontmatter", () => {
    expect(brand.companyName).toBe("Aurora Casa");
    expect(brand.description).toBe(
      "Móveis e decoração com cara de casa de verdade.",
    );
    expect(brand.language).toBe("pt-BR");
    expect(brand.storeUrl).toBe("https://aurora.example");
  });

  test("each row of the brand page feeds its field", () => {
    expect(context.tone).toBe(
      'Próximo, calmo e direto. Falamos "você", nunca "o cliente".',
    );
    expect(brand.targetAudience).toBe(
      "Quem está montando a primeira casa, entre 25 e 40 anos.",
    );
    expect(context.voiceExamples).toEqual([
      { text: "Seu sofá, do seu jeito.", sounds: true },
      { text: "Entrega montada, sem dor de cabeça.", sounds: true },
      { text: "COMPRE JÁ!!!", sounds: false },
    ]);
    expect(context.dos).toEqual([
      {
        name: "Preço",
        value: "nunca em bloco de texto; use o card de produto.",
      },
      { name: "Frases curtas.", value: "" },
      { name: "Mostrar o produto em uso.", value: "" },
    ]);
    expect(context.avoid).toEqual([
      { name: "Urgência falsa.", value: "" },
      { name: "Jargão", value: '"sinergia", "alavancar".' },
    ]);
    expect(context.vocabulary).toEqual([
      { name: "Montagem", value: 'sempre "montagem", nunca "instalação".' },
    ]);
    expect(brand.values).toEqual([
      { name: "Durabilidade", value: "móveis feitos pra durar dez anos." },
    ]);
    expect(brand.competitors).toEqual([
      { name: "Loja Exemplo", value: "preço baixo, sem montagem." },
    ]);
    expect(brand.keywords).toEqual([
      "sofá retrátil",
      "mesa de jantar",
      "tapete",
    ]);
    expect(brand.specialDates).toEqual([
      { name: "Dia das Mães", value: "maio." },
    ]);
    expect(brand.commercialPolicies).toEqual([
      { name: "Frete grátis acima de R$ 299.", value: "" },
    ]);
  });

  test("each format is a ### under the formats section", () => {
    expect(formats.formats).toEqual([
      {
        name: "Guia prático",
        value:
          "Ensina a resolver um problema da casa passo a passo, citando @ProductShelf\nquando o produto resolve.",
      },
      { name: "Lista", value: "Cinco a dez itens numerados." },
    ]);
  });

  test("with no description, the brand's own quote describes it", () => {
    const { brand: quoted } = brandForBlog(
      "# Acme\n\n> Casa é onde a vida acontece.\n",
      "acme",
    );
    expect(quoted.description).toBe("Casa é onde a vida acontece.");
  });

  test("an empty file is an empty brand named after its folder", () => {
    const empty = brandForBlog("", "aurora");
    expect(empty.brand.companyName).toBe("aurora");
    expect(empty.brand.values).toEqual([]);
    expect(empty.context.tone).toBe("");
    expect(empty.context.voiceExamples).toEqual([]);
    expect(empty.formats.formats).toEqual([]);
  });

  test("a part split across two headings is read whole", () => {
    const { context: split } = brandForBlog(
      "## Regras\n\n- Uma.\n\n## Regras de escrita\n\n- Duas.\n",
      "x",
    );
    expect(split.dos.map((rule) => rule.name)).toEqual(["Uma.", "Duas."]);
  });

  test("an oversized file still reads", () => {
    const huge = `## Regras\n\n${"- Uma regra comprida.\n".repeat(20_000)}`;
    expect(brandForBlog(huge, "x").context.dos).toHaveLength(20_000);
  });

  test("the skill's own example guide reads", () => {
    const example = readFileSync(
      join(
        import.meta.dir,
        "../../../sandbox/image/skills/brand/examples/brand.md",
      ),
      "utf8",
    );
    const read = brandForBlog(example, "acme");
    expect(read.brand.companyName).toBe("Acme");
    expect(read.context.tone).toContain('**Person:** "you", always.');
    expect(read.context.dos.length).toBeGreaterThan(0);
    expect(read.context.avoid.length).toBeGreaterThan(0);
  });
});

describe("listItems", () => {
  test("continuation lines stay with their item", () => {
    expect(listItems("- One\n  more of one.\n- Two")).toEqual([
      "One\nmore of one.",
      "Two",
    ]);
  });

  test("a paragraph with no list is one item", () => {
    expect(listItems("Just prose.\nSecond line.")).toEqual([
      "Just prose.\nSecond line.",
    ]);
    expect(listItems("   ")).toEqual([]);
  });

  test("nested bullets belong to their parent", () => {
    expect(listItems("- Parent\n  - child")).toEqual(["Parent\n- child"]);
  });
});

describe("ruleFromItem", () => {
  test("named forms", () => {
    expect(ruleFromItem("**Nome** — valor")).toEqual({
      name: "Nome",
      value: "valor",
    });
    expect(ruleFromItem("**Nome**: valor")).toEqual({
      name: "Nome",
      value: "valor",
    });
    expect(ruleFromItem("Nome: valor")).toEqual({
      name: "Nome",
      value: "valor",
    });
  });

  test("a URL is not a name", () => {
    expect(ruleFromItem("https://aurora.example/frete")).toEqual({
      name: "https://aurora.example/frete",
      value: "",
    });
  });

  test("an unnamed line is all name", () => {
    expect(ruleFromItem("Frases curtas.")).toEqual({
      name: "Frases curtas.",
      value: "",
    });
  });
});

describe("voiceExamples", () => {
  test("marks win over the heading they sit under", () => {
    expect(voiceExamples("### Soa\n\n- ❌ Não isso.\n- Isso.")).toEqual([
      { text: "Não isso.", sounds: false },
      { text: "Isso.", sounds: true },
    ]);
  });

  test("an English heading counts too", () => {
    expect(voiceExamples("### Doesn't sound like us\n\n- Buy now!")).toEqual([
      { text: "Buy now!", sounds: false },
    ]);
  });
});

describe("doDont", () => {
  test("with no marks every item is a don't", () => {
    expect(doDont("- Urgência falsa.")).toEqual({
      dos: [],
      avoid: [{ name: "Urgência falsa.", value: "" }],
    });
  });
});

test("formatsFrom ignores prose before the first format", () => {
  expect(formatsFrom("Intro.\n\n### Lista\n\nItens.")).toEqual([
    { name: "Lista", value: "Itens." },
  ]);
});
