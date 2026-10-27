import { describe, expect, test } from "bun:test";
import {
  clearUnfilled,
  imageRequests,
  sentinelRequests,
  pruneProps,
  readProps,
  withImageAt,
} from "./block-props";

/**
 * The block being rendered is the authority on what its props are. These fix
 * the three ways that can fail: a prop the block never declared, a value the
 * block declares but rejects, and a required prop the model forgot.
 */
const CALLOUT = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    variant: { type: "string", enum: ["info", "tip", "warning"] },
  },
  required: ["body"],
};

const HERO = {
  type: "object",
  properties: {
    heading: { type: "string" },
    image: { type: "string", format: "image-uri" },
    gallery: {
      type: "array",
      items: {
        type: "object",
        properties: {
          src: { type: "string", format: "image-uri" },
          alt: { type: "string" },
        },
      },
    },
  },
};

describe("readProps", () => {
  test("keeps props the block declares", () => {
    expect(
      readProps(
        '{"title":"Dica","body":"Leve menos.","variant":"tip"}',
        CALLOUT,
      ).props,
    ).toEqual({ title: "Dica", body: "Leve menos.", variant: "tip" });
  });

  test("prunes an invented prop instead of losing the section to it", () => {
    expect(
      readProps('{"body":"Leve menos.","color":"red"}', CALLOUT).props,
    ).toEqual({ body: "Leve menos." });
  });

  /**
   * The reason is the whole point of these three. A post came back with 23
   * sections dropped and nothing said which of the causes it was.
   */
  test("says so when a value is outside the block's enum", () => {
    const read = readProps('{"body":"x","variant":"neon"}', CALLOUT);
    expect(read.props).toBeUndefined();
    expect(read.reason).toContain("variant");
  });

  test("says so when a prop the block requires is missing", () => {
    const read = readProps('{"title":"Dica"}', CALLOUT);
    expect(read.props).toBeUndefined();
    expect(read.reason).toContain("body");
  });

  test("says so when the props are not valid JSON", () => {
    const read = readProps("{body: 'x'}", CALLOUT);
    expect(read.props).toBeUndefined();
    expect(read.reason).toContain("not JSON");
  });

  test("says so when the props are not an object at all", () => {
    const read = readProps('"just a string"', CALLOUT);
    expect(read.props).toBeUndefined();
    expect(read.reason).toBe("props are not an object");
  });
});

describe("pruneProps", () => {
  test("descends into an array of objects", () => {
    const pruned = pruneProps(
      { gallery: [{ src: "a.jpg", alt: "a", bogus: 1 }] },
      HERO,
    );
    expect(pruned).toEqual({ gallery: [{ src: "a.jpg", alt: "a" }] });
  });

  test("leaves a branching schema whole, since which branch applies is ajv's call", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(pruneProps({ anything: 1 }, schema)).toEqual({ anything: 1 });
  });

  test("leaves an open object alone rather than emptying it", () => {
    expect(pruneProps({ a: 1 }, { type: "object" })).toEqual({ a: 1 });
  });
});

describe("imageRequests", () => {
  test("finds a sentinel at a top-level image prop", () => {
    expect(
      imageRequests({ image: "generate:a packed suitcase" }, HERO),
    ).toEqual([{ path: ["image"], prompt: "a packed suitcase" }]);
  });

  test("finds one nested in an array", () => {
    expect(
      imageRequests(
        { gallery: [{ alt: "a" }, { src: "generate:a tent" }] },
        HERO,
      ),
    ).toEqual([{ path: ["gallery", 1, "src"], prompt: "a tent" }]);
  });

  test("ignores an address the model copied rather than asked for", () => {
    expect(imageRequests({ image: "https://cdn/x.jpg" }, HERO)).toEqual([]);
  });

  test("ignores a sentinel on a prop that is not an image", () => {
    expect(imageRequests({ heading: "generate:something" }, HERO)).toEqual([]);
  });

  test("ignores a sentinel with nothing after it", () => {
    expect(imageRequests({ image: "generate:  " }, HERO)).toEqual([]);
  });
});

describe("withImageAt", () => {
  test("writes a top-level address", () => {
    expect(
      withImageAt({ image: "generate:x" }, ["image"], "https://cdn/a.jpg"),
    ).toEqual({ image: "https://cdn/a.jpg" });
  });

  test("writes one inside an array without disturbing its siblings", () => {
    const props = { gallery: [{ src: "https://kept" }, { src: "generate:x" }] };
    expect(withImageAt(props, ["gallery", 1, "src"], "https://new")).toEqual({
      gallery: [{ src: "https://kept" }, { src: "https://new" }],
    });
  });

  test("leaves the input object untouched", () => {
    const props = { image: "generate:x" };
    withImageAt(props, ["image"], "https://cdn/a.jpg");
    expect(props.image).toBe("generate:x");
  });
});

describe("clearUnfilled", () => {
  test("blanks a sentinel no image was generated for", () => {
    expect(clearUnfilled({ image: "generate:x", heading: "Oi" })).toEqual({
      image: "",
      heading: "Oi",
    });
  });

  test("leaves a real address alone", () => {
    expect(clearUnfilled({ image: "https://cdn/a.jpg" })).toEqual({
      image: "https://cdn/a.jpg",
    });
  });

  /**
   * The bug this exists for. A site whose image prop is a plain string gets no
   * `format: image-uri`, so the schema walk never saw it — the sentinel
   * reached the decofile as an image address and rendered broken.
   */
  test("blanks one in a prop no schema declares as an image", () => {
    expect(
      clearUnfilled({ url: "generate:backpacks on a shelf", size: "full" }),
    ).toEqual({ url: "", size: "full" });
  });

  test("reaches into nested objects and arrays", () => {
    expect(
      clearUnfilled({
        slides: [{ image: "generate:a" }, { image: "https://cdn/b.jpg" }],
      }),
    ).toEqual({
      slides: [{ image: "" }, { image: "https://cdn/b.jpg" }],
    });
  });

  test("leaves prose that merely mentions the word alone", () => {
    expect(clearUnfilled({ html: "<p>Vamos generate: nada</p>" })).toEqual({
      html: "<p>Vamos generate: nada</p>",
    });
  });
});

describe("sentinelRequests", () => {
  test("finds one the schema walk cannot see, with its prompt", () => {
    expect(sentinelRequests({ url: "generate:backpacks on a shelf" })).toEqual([
      { path: ["url"], prompt: "backpacks on a shelf" },
    ]);
  });

  test("finds them inside arrays, with the index in the path", () => {
    expect(sentinelRequests({ slides: [{ image: "generate:a" }] })).toEqual([
      { path: ["slides", 0, "image"], prompt: "a" },
    ]);
  });

  test("ignores a sentinel with nothing after it", () => {
    expect(sentinelRequests({ url: "generate:" })).toEqual([]);
  });

  test("ignores a real address", () => {
    expect(sentinelRequests({ url: "https://cdn/a.jpg" })).toEqual([]);
  });
});

/**
 * deco's `@format` picks an editor control, not a value constraint. ajv has
 * never heard of `dynamic-options` and says so once per compile — a line per
 * block per run, and a red herring every time someone reads the log.
 */
describe("readProps — widget hints", () => {
  const SHELF = {
    type: "object",
    properties: {
      products: {
        type: "array",
        items: { type: "string" },
        format: "dynamic-options",
      },
      body: { type: "string", format: "textarea" },
    },
  };

  test("a widget format never decides whether props are valid", () => {
    expect(
      readProps('{"products":["1948858"],"body":"oi"}', SHELF).props,
    ).toEqual({ products: ["1948858"], body: "oi" });
  });

  test("the type under the hint is still enforced", () => {
    expect(readProps('{"products":"1948858"}', SHELF).reason).toContain(
      "must be array",
    );
  });
});

/**
 * A prop declared `string | string[]` is valid either way, so the schema
 * cannot settle it and the writer picks one. The site already settled it.
 */
describe("asStored", () => {
  const LIST = {
    type: "object",
    properties: {
      items: { anyOf: [{ type: "string" }, { type: "array" }] },
      style: { type: "string" },
    },
  };

  test("joins a list the site keeps as one string", () => {
    expect(
      readProps('{"items":["a","b","c"],"style":"ordered"}', LIST, {
        items: "x\ny",
      }).props,
    ).toEqual({ items: "a\nb\nc", style: "ordered" });
  });

  test("leaves it alone when the writer already agreed", () => {
    expect(
      readProps('{"items":"a\\nb"}', LIST, { items: "x\ny" }).props,
    ).toEqual({ items: "a\nb" });
  });

  test("splits for a site that keeps the list as a list", () => {
    expect(
      readProps('{"items":"a\\nb"}', LIST, { items: ["x", "y"] }).props,
    ).toEqual({ items: ["a", "b"] });
  });

  test("decides nothing with no block of the site's to go by", () => {
    expect(readProps('{"items":["a","b"]}', LIST).props).toEqual({
      items: ["a", "b"],
    });
  });

  test("a string that is not a list is not split", () => {
    expect(
      readProps('{"style":"ordered"}', LIST, { style: "unordered" }).props,
    ).toEqual({ style: "ordered" });
  });

  test("an empty list leaves the stored form undecided", () => {
    expect(readProps('{"items":[]}', LIST, { items: "x\ny" }).props).toEqual({
      items: [],
    });
  });
});

/**
 * Newline-joining is one encoding, not the encoding. A block that parses its
 * string as JSON gets an empty render out of a joined one, and the joined one
 * validates, so the section is kept and the page ships blank.
 */
describe("asStored — the string a site encodes rather than joins", () => {
  const ENCODED = {
    type: "object",
    properties: {
      items: { anyOf: [{ type: "string" }, { type: "array" }] },
      rows: { anyOf: [{ type: "string" }, { type: "array" }] },
      left: { anyOf: [{ type: "string" }, { type: "object" }] },
    },
  };

  test("encodes a list the site keeps as JSON in a string", () => {
    expect(
      readProps('{"items":["Alças","Rodinhas"]}', ENCODED, {
        items: '["Capacidade","Peso"]',
      }).props,
    ).toEqual({ items: '["Alças","Rodinhas"]' });
  });

  test("encodes rows of rows the same way", () => {
    expect(
      readProps('{"rows":[["Bordo","38L"]]}', ENCODED, {
        rows: '[["Média","68L"]]',
      }).props,
    ).toEqual({ rows: '[["Bordo","38L"]]' });
  });

  test("encodes an object, not only a list", () => {
    expect(
      readProps('{"left":{"title":"Com rodinhas"}}', ENCODED, {
        left: '{"title":"De costas"}',
      }).props,
    ).toEqual({ left: '{"title":"Com rodinhas"}' });
  });

  test("decodes for a site that keeps the real list", () => {
    expect(
      readProps('{"items":"[\\"a\\",\\"b\\"]"}', ENCODED, {
        items: ["x", "y"],
      }).props,
    ).toEqual({ items: ["a", "b"] });
  });

  test("a string that only looks like a bracket is still joined", () => {
    expect(
      readProps('{"items":["a","b"]}', ENCODED, { items: "[rascunho\nx" })
        .props,
    ).toEqual({ items: "a\nb" });
  });
});
