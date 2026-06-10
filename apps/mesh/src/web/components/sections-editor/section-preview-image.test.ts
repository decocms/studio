import { describe, expect, test } from "bun:test";
import {
  getSectionPreviewImageSrc,
  resolveSectionImageTemplate,
} from "./section-preview-image";
import type { LiveMeta } from "./resolve-schema";

const BANNER_COLLECTION_RT = "site/sections/Images/BannerCollection.tsx";
const LAZY = "website/sections/Rendering/Lazy.tsx";
const MV = "website/flags/multivariate/section.ts";
const NEVER = "website/matchers/never.ts";

function bannerCollectionMeta(): LiveMeta {
  return {
    manifest: { blocks: {} },
    schema: {
      definitions: {
        [btoa(BANNER_COLLECTION_RT)]: {
          allOf: [{ $ref: "#/definitions/BannerCollectionProps" }],
        },
        BannerCollectionProps: {
          image: "{{{banners.0.desktop.image}}}",
          type: "object",
          properties: {
            banners: { type: "array" },
          },
        },
      },
    },
  };
}

describe("resolveSectionImageTemplate", () => {
  test("reads @image from btoa(resolveType) Props schema via allOf", () => {
    expect(
      resolveSectionImageTemplate(BANNER_COLLECTION_RT, bannerCollectionMeta()),
    ).toBe("{{{banners.0.desktop.image}}}");
  });
});

describe("getSectionPreviewImageSrc", () => {
  test("returns undefined without meta", () => {
    const raw = {
      __resolveType: LAZY,
      section: {
        __resolveType: BANNER_COLLECTION_RT,
        banners: [{ desktop: { image: "https://example.com/banner.jpg" } }],
      },
    };
    expect(getSectionPreviewImageSrc(raw, null)).toBeUndefined();
  });

  test("renders lazy BannerCollection like admin getItemImageSrc", () => {
    const desktopImage = "https://example.com/banner.jpg";
    const raw = {
      __resolveType: LAZY,
      section: {
        __resolveType: BANNER_COLLECTION_RT,
        banners: [{ desktop: { image: desktopImage } }],
      },
    };
    expect(getSectionPreviewImageSrc(raw, bannerCollectionMeta())).toBe(
      desktopImage,
    );
  });

  test("rejects non-https image URLs", () => {
    const raw = {
      __resolveType: LAZY,
      section: {
        __resolveType: BANNER_COLLECTION_RT,
        banners: [{ desktop: { image: "http://example.com/banner.jpg" } }],
      },
    };
    expect(
      getSectionPreviewImageSrc(raw, bannerCollectionMeta()),
    ).toBeUndefined();
  });

  test("visible lazy and hidden lazy produce the same preview path", () => {
    const meta = bannerCollectionMeta();
    const desktopImage = "https://example.com/banner.jpg";

    const visibleLazy = {
      __resolveType: LAZY,
      section: {
        __resolveType: BANNER_COLLECTION_RT,
        banners: [{ desktop: { image: desktopImage } }],
      },
    };

    const hiddenLazy = {
      __resolveType: MV,
      variants: [
        {
          value: visibleLazy,
          rule: { __resolveType: NEVER },
        },
      ],
    };

    expect(getSectionPreviewImageSrc(visibleLazy, meta)).toBe(desktopImage);
    expect(getSectionPreviewImageSrc(hiddenLazy, meta)).toBe(desktopImage);
  });

  test("renders lazy-outside hidden section (legacy shape)", () => {
    const desktopImage = "https://example.com/legacy-hidden.jpg";
    const raw = {
      __resolveType: LAZY,
      section: {
        __resolveType: MV,
        variants: [
          {
            value: {
              __resolveType: BANNER_COLLECTION_RT,
              banners: [{ desktop: { image: desktopImage } }],
            },
            rule: { __resolveType: NEVER },
          },
        ],
      },
    };

    expect(getSectionPreviewImageSrc(raw, bannerCollectionMeta())).toBe(
      desktopImage,
    );
  });

  test("renders hidden multivariate with lazy inner section", () => {
    const desktopImage = "https://example.com/hidden-banner.jpg";
    const src = getSectionPreviewImageSrc(
      {
        __resolveType: MV,
        variants: [
          {
            value: {
              __resolveType: LAZY,
              section: {
                __resolveType: BANNER_COLLECTION_RT,
                banners: [{ desktop: { image: desktopImage } }],
              },
            },
            rule: { __resolveType: NEVER },
          },
        ],
      },
      bannerCollectionMeta(),
    );

    expect(src).toBe(desktopImage);
  });
});
