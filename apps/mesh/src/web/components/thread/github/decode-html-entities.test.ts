import { describe, expect, test } from "bun:test";
import { decodeHtmlEntities } from "./decode-html-entities";

describe("decodeHtmlEntities", () => {
  test("passes through plain text unchanged", () => {
    expect(decodeHtmlEntities("hello world")).toBe("hello world");
  });

  test("decodes numeric entities like &#34;", () => {
    expect(decodeHtmlEntities("say &#34;hi&#34;")).toBe('say "hi"');
  });

  test("decodes hex numeric entities like &#x27;", () => {
    expect(decodeHtmlEntities("it&#x27;s")).toBe("it's");
  });

  test("decodes named entities &amp; &lt; &gt; &quot; &#39;", () => {
    expect(
      decodeHtmlEntities("A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39;"),
    ).toBe("A & B < C > D \"E\" 'F'");
  });

  test("is safe on null/empty input", () => {
    expect(decodeHtmlEntities("")).toBe("");
    expect(decodeHtmlEntities(null)).toBe("");
    expect(decodeHtmlEntities(undefined)).toBe("");
  });

  test("real-world PR title from GitHub API", () => {
    expect(
      decodeHtmlEntities(
        "feat: change Hero title to &#34;Hello VTEX DAY 2026&#34;",
      ),
    ).toBe('feat: change Hero title to "Hello VTEX DAY 2026"');
  });
});
