/**
 * Golden fixtures for canonical content hashing: every implementation that
 * computes a content revision (the CLI, the release materializer, the site
 * editor's backend) checks it produces these exact bytes and hashes.
 *
 * ```ts
 * import { contentHashFixtures } from "@decocms/blocks/protocol/conformance";
 * for (const f of contentHashFixtures) expect(await myRevision(f.blocks)).toBe(f.revision);
 * ```
 */

export interface ContentHashFixture {
  id: string;
  title: string;
  /** The `blocks` map: entry name to entry. */
  blocks: Record<string, unknown>;
  /** Its canonical JSON. */
  canonical: string;
  /** SHA-256 of the canonical JSON's UTF-8 bytes, lowercase hex. */
  revision: string;
}

export const contentHashFixtures: readonly ContentHashFixture[] = [
  {
    id: "empty",
    title: "an empty map",
    blocks: {},
    canonical: "{}",
    revision:
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  },
  {
    id: "key-order",
    title:
      "keys sorted recursively in code-unit order, numeric-looking keys included; arrays keep their order",
    blocks: {
      b: { z: 1, a: 2 },
      a: [3, 1, 2],
      B: true,
      "10": "ten",
      "2": "two",
      "": null,
    },
    canonical:
      '{"":null,"10":"ten","2":"two","B":true,"a":[3,1,2],"b":{"a":2,"z":1}}',
    revision:
      "e10ffc5fe1399986d69ff6a5c326d3eca5a4c6ff4134504d2e169676e1155e52",
  },
  {
    id: "strings",
    title:
      "JSON string escaping: control characters escaped, non-ASCII and line separators as is",
    blocks: {
      s: {
        text: "Ol\u00e1 \u2014 \u4e16\u754c \ud83d\ude00",
        quote: '"\\/',
        control: "\u0000\u001f\n\t",
        separators: "\u2028\u2029",
      },
    },
    canonical:
      '{"s":{"control":"\\u0000\\u001f\\n\\t","quote":"\\"\\\\/","separators":"\u2028\u2029","text":"Ol\u00e1 \u2014 \u4e16\u754c \ud83d\ude00"}}',
    revision:
      "3dbb4dd183b625c383b703df94c2d12ae6271cad0ee7e63c51cf1bfda18c799c",
  },
  {
    id: "numbers",
    title: "JSON number encoding, negative zero as zero",
    blocks: {
      n: {
        zero: -0,
        int: 42,
        neg: -7,
        frac: 0.1,
        big: 1e21,
        small: 1e-7,
        max: 9007199254740991,
      },
    },
    canonical:
      '{"n":{"big":1e+21,"frac":0.1,"int":42,"max":9007199254740991,"neg":-7,"small":1e-7,"zero":0}}',
    revision:
      "783d90091668991414259155fb6b37ae5f09afc80a3aea62405fbe515bac535c",
  },
  {
    id: "page",
    title: "a small site",
    blocks: {
      "pages-Home": {
        __resolveType: "page",
        path: "/",
        sections: [{ __resolveType: "hero", title: "Hi" }],
      },
      Header: { __resolveType: "header", links: [] },
    },
    canonical:
      '{"Header":{"__resolveType":"header","links":[]},"pages-Home":{"__resolveType":"page","path":"/","sections":[{"__resolveType":"hero","title":"Hi"}]}}',
    revision:
      "6913c5e6aa28f441d3b0102177b372e4fb7c08bc09bdd8698df85e597282ac96",
  },
];
