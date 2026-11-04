import { describe, expect, test } from "bun:test";
import { checkSections } from "./post-assemble";

const HEADING = {
  name: "Heading",
  title: "Título",
  description: "",
  schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      level: { type: "string", enum: ["h2", "h3"] },
    },
    required: ["text"],
  },
};

describe("checkSections", () => {
  test("keeps a section its block accepts, without props it never declared", () => {
    const { sections, reasons } = checkSections(
      [
        {
          type: "Heading",
          props: { text: "Mala de bordo", level: "h2", color: "red" },
          productIds: [],
        },
      ],
      [HEADING],
    );
    expect(reasons).toEqual([]);
    expect(sections).toEqual([
      {
        type: "Heading",
        props: { text: "Mala de bordo", level: "h2" },
        productIds: [],
      },
    ]);
  });

  test("drops a section its block rejects, and says which and why", () => {
    const { sections, reasons } = checkSections(
      [{ type: "Heading", props: { level: "h9" }, productIds: [] }],
      [HEADING],
    );
    expect(sections).toEqual([]);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toStartWith("Heading: ");
  });

  test("drops a block this site does not render", () => {
    const { sections, reasons } = checkSections(
      [{ type: "Carousel", props: {}, productIds: [] }],
      [HEADING],
    );
    expect(sections).toEqual([]);
    expect(reasons).toEqual(["Carousel: not a block this site renders"]);
  });
});
