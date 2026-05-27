import { describe, expect, it } from "bun:test";
import { parseSections } from "./parse-sections";

describe("parseSections", () => {
  it("labels inline manifest sections from resolve type path", () => {
    const parsed = parseSections(
      [{ __resolveType: "site/sections/Hero/Hero.tsx" }],
      {},
    );
    expect(parsed[0]?.label).toBe("Hero");
    expect(parsed[0]?.isSavedBlock).toBeUndefined();
  });

  it("detects saved block references from decofile", () => {
    const parsed = parseSections([{ __resolveType: "Header" }], {
      Header: {
        __resolveType: "site/sections/Header/Header.tsx",
        name: "Site Header",
      },
    });
    expect(parsed[0]?.isSavedBlock).toBe(true);
    expect(parsed[0]?.label).toBe("Site Header");
  });

  it("detects lazy-wrapped saved blocks", () => {
    const parsed = parseSections(
      [
        {
          __resolveType: "website/sections/Rendering/Lazy.tsx",
          section: { __resolveType: "Header" },
        },
      ],
      {
        Header: { __resolveType: "site/sections/Header/Header.tsx" },
      },
    );
    expect(parsed[0]?.isSavedBlock).toBe(true);
    expect(parsed[0]?.isLazy).toBe(true);
  });

  it("detects multivariate sections", () => {
    const parsed = parseSections(
      [
        {
          __resolveType: "website/flags/multivariate/section.ts",
          variants: [
            {
              value: { __resolveType: "site/sections/Footer/Footer.tsx" },
              rule: { __resolveType: "website/matchers/always.ts" },
            },
          ],
        },
      ],
      {},
    );
    expect(parsed[0]?.isMultivariate).toBe(true);
    expect(parsed[0]?.label).toContain("Footer");
  });

  it("marks never-matcher single variants as hidden", () => {
    const parsed = parseSections(
      [
        {
          __resolveType: "website/flags/multivariate/section.ts",
          variants: [
            {
              value: { __resolveType: "site/sections/Hero/Hero.tsx" },
              rule: { __resolveType: "website/matchers/never.ts" },
            },
          ],
        },
      ],
      {},
    );
    expect(parsed[0]?.isHidden).toBe(true);
  });
});
