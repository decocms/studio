import { describe, expect, test } from "bun:test";
import { unwrapListContinuations } from "./unwrap-list-continuations";

describe("unwrapListContinuations", () => {
  test("joins a wrapped ordered item onto its marker line", () => {
    expect(
      unwrapListContinuations(
        `1. um item curto.
2. um item que passa da margem
   e continua aqui.
3. outro.`,
      ),
    ).toBe(
      `1. um item curto.
2. um item que passa da margem e continua aqui.
3. outro.`,
    );
  });

  test("joins every continuation line of the same item", () => {
    expect(
      unwrapListContinuations(`- primeira
  segunda
  terceira`),
    ).toBe("- primeira segunda terceira");
  });

  test("leaves a nested list alone", () => {
    const src = `- pai
  - filho
    continuação do filho`;
    expect(unwrapListContinuations(src)).toBe(`- pai
  - filho continuação do filho`);
  });

  test("a blank line ends the item, so the next block is untouched", () => {
    const src = `- item

  parágrafo solto do item`;
    expect(unwrapListContinuations(src)).toBe(src);
  });

  test("does not touch paragraphs outside a list", () => {
    const src = `uma linha
outra linha`;
    expect(unwrapListContinuations(src)).toBe(src);
  });

  test("does not touch a fenced code block inside an item", () => {
    const src = `- roda isto:

\`\`\`sh
  bun test
    --watch
\`\`\``;
    expect(unwrapListContinuations(src)).toBe(src);
  });

  test("a following heading or quote stays its own block", () => {
    const src = `- item
  > citação`;
    expect(unwrapListContinuations(src)).toBe(src);
  });

  test("empty input", () => {
    expect(unwrapListContinuations("")).toBe("");
  });
});
