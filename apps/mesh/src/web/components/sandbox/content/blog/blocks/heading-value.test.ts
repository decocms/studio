import { describe, expect, test } from "bun:test";
import { formatHeadingValue, parseHeadingValue } from "./heading-value";

describe("parseHeadingValue", () => {
  test("reads a plain string as normal", () => {
    expect(parseHeadingValue("Ofertas")).toEqual({
      level: "normal",
      text: "Ofertas",
    });
  });

  test("reads a wrapped heading and unwraps the text", () => {
    expect(parseHeadingValue("<h1>Ofertas</h1>")).toEqual({
      level: "h1",
      text: "Ofertas",
    });
    expect(parseHeadingValue("<h3>Mais vendidos</h3>")).toEqual({
      level: "h3",
      text: "Mais vendidos",
    });
  });

  test("is case-insensitive on the tag", () => {
    expect(parseHeadingValue("<H2>Título</H2>")).toEqual({
      level: "h2",
      text: "Título",
    });
  });

  test("treats mismatched or partial tags as normal text", () => {
    expect(parseHeadingValue("<h1>Ofertas</h2>")).toEqual({
      level: "normal",
      text: "<h1>Ofertas</h2>",
    });
    expect(parseHeadingValue("<h1>Ofertas")).toEqual({
      level: "normal",
      text: "<h1>Ofertas",
    });
  });

  test("handles empty string", () => {
    expect(parseHeadingValue("")).toEqual({ level: "normal", text: "" });
  });
});

describe("formatHeadingValue", () => {
  test("wraps non-normal levels", () => {
    expect(formatHeadingValue("h1", "Ofertas")).toBe("<h1>Ofertas</h1>");
    expect(formatHeadingValue("h2", "Título")).toBe("<h2>Título</h2>");
  });

  test("leaves normal text bare", () => {
    expect(formatHeadingValue("normal", "Ofertas")).toBe("Ofertas");
  });

  test("empty text always stores an empty string", () => {
    expect(formatHeadingValue("normal", "")).toBe("");
    expect(formatHeadingValue("h1", "")).toBe("");
  });

  test("round-trips with parseHeadingValue", () => {
    for (const value of ["Ofertas", "<h1>A</h1>", "<h2>B</h2>", "<h3>C</h3>"]) {
      const { level, text } = parseHeadingValue(value);
      expect(formatHeadingValue(level, text)).toBe(value);
    }
  });
});
