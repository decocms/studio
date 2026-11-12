import { describe, expect, test } from "bun:test";
import "../../../../../../test/setup";
import {
  blankIfEmpty,
  bodyImageSrc,
  importAsLegacyContent,
  normalizeLegacyHtml,
} from "./legacy-content";

/** A body in the shape the deco admin's editor saved, with synthetic text. */
const ADMIN_BODY = [
  '<p style="text-align: justify;"><span style="font-size: 12pt; color: rgb(33, 33, 33);">Intro with <strong>bold</strong> and <em>italic</em>.</span></p>',
  '<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/a">A link</a></p>',
  '<p style="text-align: center;"><img src="https://cdn.example.com/site/photo.jpg"><br><span style="font-size: 10pt;"><strong><em>Caption</em></strong></span></p>',
  "<h2>Section</h2><h4>Smaller</h4>",
  "<ul><li><p>one</p></li><li><p>two</p></li></ul><ol><li><p>first</p></li></ol>",
  "<p>[CARROSEL]</p>",
  '<p><mark data-color="#fde047" style="background-color: #fde047; color: inherit;">marked</mark> <u>underlined</u></p>',
].join("");

describe("normalizeLegacyHtml", () => {
  test("keeps a body the admin saved as it is", () => {
    expect(normalizeLegacyHtml(ADMIN_BODY)).toBe(ADMIN_BODY);
  });

  test("is stable: a normalized body normalizes to itself", () => {
    const messy =
      '<p style="text-align: justify"><span style="font-size: 12pt">a <a href="https://e.com">l</a></span></p>';
    const once = normalizeLegacyHtml(messy);
    expect(normalizeLegacyHtml(once)).toBe(once);
  });

  test("keeps a link without a target in the same tab", () => {
    const html =
      '<p><a href="/blog/other-post">internal</a> and <a target="_blank" rel="noopener" href="https://e.com">external</a></p>';
    expect(normalizeLegacyHtml(html)).toBe(html);
  });

  test("keeps an image inside its paragraph", () => {
    expect(
      normalizeLegacyHtml(
        '<p>before <img src="https://e.com/i.png"> after</p>',
      ),
    ).toBe('<p>before <img src="https://e.com/i.png"> after</p>');
  });

  test("keeps tables and code blocks it cannot author", () => {
    const html = normalizeLegacyHtml(
      "<table><tbody><tr><td><p>cell</p></td></tr></tbody></table><pre><code>x</code></pre>",
    );
    expect(html).toContain("<td");
    expect(html).toContain(">cell<");
    expect(html).toContain("<pre><code>x</code></pre>");
  });

  test("drops markup outside the schema and unsafe addresses", () => {
    expect(
      normalizeLegacyHtml(
        '<p onclick="steal()"><a href="javascript:alert(1)">x</a></p><iframe src="https://e.com/embed"></iframe><script>alert(1)</script><div class="c">d</div>',
      ),
    ).toBe("<p>x</p><p>d</p>");
  });

  test("drops an unsafe image and the paragraph it leaves empty", () => {
    expect(
      normalizeLegacyHtml(
        '<p><img src="javascript:alert(1)"></p><p>text<img src="data:image/png;base64,AAAA"></p>',
      ),
    ).toBe("<p>text</p>");
  });

  test("an empty body is stored as an empty string", () => {
    expect(normalizeLegacyHtml("")).toBe("");
    expect(normalizeLegacyHtml("<p></p>")).toBe("");
  });

  test("handles a long body", () => {
    const body = "<p>paragraph text</p>".repeat(2000);
    expect(normalizeLegacyHtml(body)).toBe(body);
  });
});

describe("importAsLegacyContent", () => {
  test("lifts the first H1 of HTML into the title", () => {
    expect(
      importAsLegacyContent("<h1>The title</h1><p>Body</p><h1>Second</h1>"),
    ).toEqual({
      title: "The title",
      content: "<p>Body</p><h1>Second</h1>",
    });
  });

  test("converts Markdown to HTML", () => {
    const { title, content } = importAsLegacyContent(
      "# Title\n\nSome **bold** text.\n\n- a\n- b\n\n## Sub",
    );
    expect(title).toBe("Title");
    expect(content).toBe(
      "<p>Some <strong>bold</strong> text.</p><ul><li><p>a</p></li><li><p>b</p></li></ul><h2>Sub</h2>",
    );
  });

  test("drops unsafe links and images from Markdown", () => {
    const { content } = importAsLegacyContent(
      "Text [bad](javascript:alert(1)).\n\n![x](javascript:alert(1))\n\n![ok](https://e.com/a.png)",
    );
    expect(content).toBe(
      '<p>Text bad.</p><p><img src="https://e.com/a.png" alt="ok"></p>',
    );
  });

  test("an empty or title-only paste has an empty body", () => {
    expect(importAsLegacyContent("   ")).toEqual({ title: "", content: "" });
    expect(importAsLegacyContent("<h1>Only a title</h1>")).toEqual({
      title: "Only a title",
      content: "",
    });
  });
});

describe("bodyImageSrc", () => {
  test("keeps addresses the body can store", () => {
    expect(bodyImageSrc("https://e.com/a.png")).toBe("https://e.com/a.png");
    expect(bodyImageSrc("/assets/a.png")).toBe("/assets/a.png");
  });

  test("refuses data images, which the schema drops on the next load", () => {
    expect(bodyImageSrc("data:image/png;base64,AAAA")).toBe("");
    expect(bodyImageSrc("DATA:image/png;base64,AAAA")).toBe("");
  });

  test("refuses unsafe schemes", () => {
    expect(bodyImageSrc("javascript:alert(1)")).toBe("");
  });
});

describe("blankIfEmpty", () => {
  test("only an empty paragraph is blank", () => {
    expect(blankIfEmpty("<p></p>")).toBe("");
    expect(blankIfEmpty("<p>x</p>")).toBe("<p>x</p>");
  });
});
