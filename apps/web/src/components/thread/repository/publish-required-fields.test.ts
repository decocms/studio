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
const def = (rt: string) => ({ $ref: `#/definitions/${btoa(rt)}` });

/** A listing section whose promo cards need a headline, an image and a link. */
const META = {
  manifest: {
    blocks: {
      sections: { [LISTING]: def(LISTING) },
      loaders: { [SECRET]: def(SECRET) },
    },
  },
  schema: {
    definitions: {
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
): PublishChange => ({
  kind: "block",
  blockKey: name,
  name,
  pagePath: null,
  isSiteApp: false,
  status: "edited",
  filepaths: [],
  sections: [],
  fromJson: null,
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
    expect(gate({ contentPending: true, contentFailed: true }).checking).toBe(
      false,
    );
  });

  test("without the site schema nothing is judged", () => {
    expect(gate({ meta: undefined, contentPending: true })).toEqual({
      found: [],
      checking: false,
      blocks: false,
    });
  });
});
