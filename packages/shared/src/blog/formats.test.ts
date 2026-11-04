import { describe, expect, test } from "bun:test";
import { formatExampleSlugs } from "./formats";

describe("formatExampleSlugs", () => {
  test("reads each example address as the slug of the post it points at", () => {
    expect(
      formatExampleSlugs(
        "## Exemplos\n\n- https://www.loja.com.br/blog/material-da-mala\n- (https://www.loja.com.br/blog/mala-de-bordo/) e https://www.loja.com.br/blog/material-da-mala",
      ),
    ).toEqual(["material-da-mala", "mala-de-bordo"]);
  });

  test("a sentence's punctuation after an address is not part of its slug", () => {
    expect(
      formatExampleSlugs(
        "Veja https://www.loja.com.br/blog/mala-de-bordo. E também https://www.loja.com.br/blog/tamanhos, por exemplo.",
      ),
    ).toEqual(["mala-de-bordo", "tamanhos"]);
  });

  test("finds none in a format without addresses", () => {
    expect(formatExampleSlugs("Abre com @Heading.")).toEqual([]);
  });
});
