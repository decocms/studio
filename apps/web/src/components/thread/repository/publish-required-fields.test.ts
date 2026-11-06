import { describe, expect, test } from "bun:test";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema.ts";
import type { PublishChange } from "./publish-change-summary.ts";
import {
  publishRequiredFields,
  publishRequiredFieldsGate,
  requiredFieldLabel,
  requiredFieldsBlockPublish,
} from "./publish-required-fields.ts";

const LISTING = "site/sections/Listing.tsx";
const SECRET = "website/loaders/secret.ts";
const WRAPPER = "site/sections/Wrapper.tsx";
const def = (rt: string) => ({ $ref: `#/definitions/${btoa(rt)}` });

/** A listing section whose promo cards need a headline, an image and a link. */
const META = {
  manifest: {
    blocks: {
      sections: { [LISTING]: def(LISTING), [WRAPPER]: def(WRAPPER) },
      loaders: { [SECRET]: def(SECRET) },
    },
  },
  schema: {
    definitions: {
      [btoa(WRAPPER)]: {
        title: WRAPPER,
        type: "object",
        properties: {
          __resolveType: { type: "string", enum: [WRAPPER], default: WRAPPER },
          inner: { type: "object", title: "Inner section" },
        },
      },
      [btoa(SECRET)]: {
        title: SECRET,
        type: "object",
        required: ["__resolveType", "ciphertext"],
        properties: {
          __resolveType: { type: "string", enum: [SECRET], default: SECRET },
          ciphertext: { type: "string", title: "Ciphertext", writeOnly: true },
        },
      },
      [btoa(LISTING)]: {
        title: LISTING,
        type: "object",
        properties: {
          __resolveType: { type: "string", enum: [LISTING], default: LISTING },
          apiKey: {
            type: "object",
            title: "API key",
            required: ["__resolveType", "ciphertext"],
            properties: {
              __resolveType: { type: "string" },
              ciphertext: { type: "string" },
            },
          },
          promoCards: {
            type: "array",
            title: "Promo cards",
            items: {
              type: "object",
              required: ["headline", "image", "cta"],
              properties: {
                headline: { type: "string", title: "Headline" },
                image: { type: "string", title: "Image" },
                cta: {
                  type: "object",
                  title: "Button",
                  required: ["link"],
                  properties: {
                    link: { type: "string", title: "Link" },
                    variant: { type: "string", default: "solid" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as unknown as LiveMeta;

const FILLED_CARD = {
  headline: "Sale",
  image: "a.png",
  cta: { link: "/sale", variant: "solid" },
};
const EMPTY_CARD = { cta: { variant: "solid" } };

const change = (
  name: string,
  toJson: Record<string, unknown> | null,
  fromJson: Record<string, unknown> | null = null,
): PublishChange => ({
  kind: "block",
  blockKey: name,
  name,
  pagePath: null,
  isSiteApp: false,
  status: "edited",
  filepaths: [],
  sections: [],
  fromJson,
  toJson,
});

describe("publishRequiredFields", () => {
  test("a saved section with an unfilled promo card is caught, field by field", () => {
    const found = publishRequiredFields(
      [
        change("Example listing", {
          __resolveType: LISTING,
          promoCards: [FILLED_CARD, EMPTY_CARD],
        }),
      ],
      META,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.fields.map(requiredFieldLabel)).toEqual([
      "Promo cards › 2 › Headline",
      "Promo cards › 2 › Image",
      "Promo cards › 2 › Button › Link",
    ]);
    expect(requiredFieldsBlockPublish(found)).toBe(true);
  });

  test("the way to a nested block is labeled by its parent's prop titles", () => {
    const found = publishRequiredFields(
      [
        change("Example wrapper", {
          __resolveType: WRAPPER,
          inner: { __resolveType: LISTING, promoCards: [EMPTY_CARD] },
        }),
      ],
      META,
    );
    expect(found[0]!.fields.map(requiredFieldLabel)).toContain(
      "Inner section › Promo cards › 1 › Headline",
    );
  });

  test("a section inside a page, lazy-wrapped or not, is judged by its own schema", () => {
    const found = publishRequiredFields(
      [
        change("Example page", {
          __resolveType: "website/pages/Page.tsx",
          sections: [
            { __resolveType: LISTING, promoCards: [EMPTY_CARD] },
            {
              __resolveType: "website/sections/Rendering/Lazy.tsx",
              section: { __resolveType: LISTING, promoCards: [EMPTY_CARD] },
            },
          ],
        }),
      ],
      META,
    );
    expect(found[0]!.fields.map((f) => f.path.join("."))).toEqual([
      "sections.0.promoCards.0.headline",
      "sections.0.promoCards.0.image",
      "sections.0.promoCards.0.cta.link",
      "sections.1.section.promoCards.0.headline",
      "sections.1.section.promoCards.0.image",
      "sections.1.section.promoCards.0.cta.link",
    ]);
  });

  test("blank fields are listed but don't stop a Publish", () => {
    const found = publishRequiredFields(
      [
        change("Example listing", {
          __resolveType: LISTING,
          promoCards: [{ ...FILLED_CARD, headline: "" }],
        }),
      ],
      META,
    );
    expect(found[0]!.fields.map(requiredFieldLabel)).toEqual([
      "Promo cards › 1 › Headline",
    ]);
    expect(requiredFieldsBlockPublish(found)).toBe(false);
  });

  test("filled content, deletions, saved-block references, secrets and unknown blocks pass", () => {
    expect(
      publishRequiredFields(
        [
          change("Filled", {
            __resolveType: LISTING,
            promoCards: [FILLED_CARD],
          }),
          change("Deleted", null),
          change("Page using a saved section", {
            __resolveType: "website/pages/Page.tsx",
            sections: [{ __resolveType: "Example listing" }],
          }),
          change("Section with a secret stored the older way", {
            __resolveType: LISTING,
            promoCards: [FILLED_CARD],
            apiKey: {
              __resolveType: SECRET,
              name: "apiKey",
              encrypted: "ab12",
            },
          }),
          change("Unknown type", {
            __resolveType: "site/sections/Other.tsx",
            promoCards: [EMPTY_CARD],
          }),
        ],
        META,
      ),
    ).toEqual([]);
  });
});

describe("publishRequiredFieldsGate", () => {
  const unfilled = [
    change("Example listing", {
      __resolveType: LISTING,
      promoCards: [EMPTY_CARD],
    }),
  ];
  const gate = (
    over: Partial<Parameters<typeof publishRequiredFieldsGate>[0]>,
  ) =>
    publishRequiredFieldsGate({
      meta: META,
      check: "all",
      changes: unfilled,
      contentPending: false,
      contentFailed: false,
      review: false,
      ...over,
    });

  test("a missing required field holds the Publish", () => {
    expect(gate({})).toMatchObject({ checking: false, blocks: true });
  });

  test("a review submission lists the fields but goes through", () => {
    const { found, blocks } = gate({ review: true });
    expect(found).toHaveLength(1);
    expect(blocks).toBe(false);
  });

  test("the Publish waits while the changes load, not when they failed to", () => {
    expect(gate({ contentPending: true })).toEqual({
      found: [],
      checking: true,
      blocks: true,
    });
    // A failed load leaves the changes without content: nothing to judge.
    expect(
      gate({
        changes: [change("Example listing", null)],
        contentPending: true,
        contentFailed: true,
      }),
    ).toEqual({ found: [], checking: false, blocks: false });
  });

  test("without the site schema nothing is judged", () => {
    expect(gate({ meta: undefined, contentPending: true })).toEqual({
      found: [],
      checking: false,
      blocks: false,
    });
  });
});

describe("the site's content check", () => {
  const published = { __resolveType: LISTING, promoCards: [EMPTY_CARD] };
  const blocking = (
    check: "none" | "changes" | "all" | undefined,
    changes: PublishChange[],
  ) =>
    publishRequiredFieldsGate({
      meta: META,
      check,
      changes,
      contentPending: false,
      contentFailed: false,
      review: false,
    }).blocks;

  test("`changes` only lists a field the published version already left missing", () => {
    const edited = [
      change(
        "Example listing",
        { ...published, title: "New title" },
        published,
      ),
    ];
    expect(blocking("changes", edited)).toBe(false);
    const found = publishRequiredFields(edited, META, "changes");
    expect(found[0]!.fields.map(requiredFieldLabel)).toEqual([
      "Promo cards › 1 › Headline",
      "Promo cards › 1 › Image",
      "Promo cards › 1 › Button › Link",
    ]);
    expect(blocking("all", edited)).toBe(true);
  });

  test("`changes` holds a field the change leaves missing, and every one in a new block", () => {
    const addedCard = change(
      "Example listing",
      { __resolveType: LISTING, promoCards: [FILLED_CARD, EMPTY_CARD] },
      { __resolveType: LISTING, promoCards: [FILLED_CARD] },
    );
    expect(blocking("changes", [addedCard])).toBe(true);
    expect(blocking("changes", [change("New listing", published)])).toBe(true);
  });

  test("`changes` follows an already-missing field to its new index", () => {
    const moved = change(
      "Example listing",
      { __resolveType: LISTING, promoCards: [FILLED_CARD, EMPTY_CARD] },
      published,
    );
    expect(blocking("changes", [moved])).toBe(false);
  });

  test("unset checks nothing", () => {
    expect(
      publishRequiredFieldsGate({
        meta: META,
        check: undefined,
        changes: [change("New listing", published)],
        contentPending: false,
        contentFailed: false,
        review: false,
      }),
    ).toEqual({ found: [], checking: false, blocks: false });
  });

  test("`changes` holds a new item that takes an already-broken item's index", () => {
    const inserted = change(
      "Example listing",
      { __resolveType: LISTING, promoCards: [EMPTY_CARD, EMPTY_CARD] },
      published,
    );
    const found = publishRequiredFields([inserted], META, "changes");
    expect(
      found[0]!.fields.filter((f) => f.blocks).map(requiredFieldLabel),
    ).toEqual([
      "Promo cards › 2 › Headline",
      "Promo cards › 2 › Image",
      "Promo cards › 2 › Button › Link",
    ]);
  });

  test("`changes` only lists an already-broken item edited in place", () => {
    const edited = change(
      "Example listing",
      {
        __resolveType: LISTING,
        promoCards: [{ cta: { variant: "outline" } }],
      },
      published,
    );
    expect(blocking("changes", [edited])).toBe(false);
  });

  test("`none` checks nothing", () => {
    expect(
      publishRequiredFieldsGate({
        meta: META,
        check: "none",
        changes: [change("New listing", published)],
        contentPending: true,
        contentFailed: false,
        review: false,
      }),
    ).toEqual({ found: [], checking: false, blocks: false });
  });
});
