import { describe, expect, test } from "bun:test";
import {
  getSectionPreviewImageSrc,
  resolveSectionImageTemplate,
} from "./section-preview-image";
import type { LiveMeta } from "./resolve-schema";

const BANNER_COLLECTION_RT = "site/sections/Images/BannerCollection.tsx";

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

const farmrioLazyBanner = {
  __resolveType: "website/sections/Rendering/Lazy.tsx",
  section: {
    __resolveType: BANNER_COLLECTION_RT,
    banners: [
      {
        desktop: {
          image:
            "https://cf.farmriosoma.farmrio.com.br/site/2026/06_JUNHO/09_VITRINE/desktop/home-banner-2-sec-vestidos-desktop.jpg?authuser=1",
        },
      },
    ],
  },
};

describe("resolveSectionImageTemplate", () => {
  test("reads @image from btoa(resolveType) Props schema via allOf", () => {
    expect(
      resolveSectionImageTemplate(BANNER_COLLECTION_RT, bannerCollectionMeta()),
    ).toBe("{{{banners.0.desktop.image}}}");
  });
});

describe("getSectionPreviewImageSrc", () => {
  test("returns undefined without meta", () => {
    expect(getSectionPreviewImageSrc(farmrioLazyBanner, null)).toBeUndefined();
  });

  test("renders lazy BannerCollection like admin getItemImageSrc", () => {
    const src = getSectionPreviewImageSrc(
      farmrioLazyBanner,
      bannerCollectionMeta(),
    );

    expect(src).toBe(
      "https://cf.farmriosoma.farmrio.com.br/site/2026/06_JUNHO/09_VITRINE/desktop/home-banner-2-sec-vestidos-desktop.jpg?authuser=1",
    );
  });

  test("visible lazy and hidden lazy produce the same preview path", () => {
    const meta = bannerCollectionMeta();
    const desktopImage = "https://example.com/banner.jpg";

    const visibleLazy = {
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: {
        __resolveType: BANNER_COLLECTION_RT,
        banners: [{ desktop: { image: desktopImage } }],
      },
    };

    const hiddenLazy = {
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          value: visibleLazy,
          rule: { __resolveType: "website/matchers/never.ts" },
        },
      ],
    };

    expect(getSectionPreviewImageSrc(visibleLazy, meta)).toBe(desktopImage);
    expect(getSectionPreviewImageSrc(hiddenLazy, meta)).toBe(desktopImage);
  });

  test("renders hidden multivariate with lazy inner section", () => {
    const desktopImage = "https://example.com/hidden-banner.jpg";
    const src = getSectionPreviewImageSrc(
      {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          {
            value: {
              __resolveType: "website/sections/Rendering/Lazy.tsx",
              section: {
                __resolveType: BANNER_COLLECTION_RT,
                banners: [{ desktop: { image: desktopImage } }],
              },
            },
            rule: { __resolveType: "website/matchers/never.ts" },
          },
        ],
      },
      bannerCollectionMeta(),
    );

    expect(src).toBe(desktopImage);
  });
});
