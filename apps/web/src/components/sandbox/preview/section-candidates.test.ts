import { describe, expect, it } from "bun:test";
import { resolveSectionCandidates } from "./section-candidates";

const NEVER = "website/matchers/never.ts";
const SECTION_MULTIVARIATE = "website/flags/multivariate/section.ts";
const LAZY = "website/sections/Rendering/Lazy.tsx";
const BANNER = "site/sections/Images/BannersGrid.tsx";
const HEADER = "site/sections/Header/Header.tsx";

describe("resolveSectionCandidates", () => {
  it("returns the resolve type for a plain section", () => {
    expect(resolveSectionCandidates({ __resolveType: BANNER }, {})).toEqual([
      BANNER,
    ]);
  });

  it("returns both loader and inner keys for a lazy section", () => {
    expect(
      resolveSectionCandidates(
        { __resolveType: LAZY, section: { __resolveType: BANNER } },
        {},
      ),
    ).toEqual([LAZY, BANNER]);
  });

  it("resolves saved-block references through the decofile", () => {
    expect(
      resolveSectionCandidates(
        { __resolveType: "my-saved-header" },
        { "my-saved-header": { __resolveType: HEADER } },
      ),
    ).toEqual([HEADER]);
  });

  it("collects every variant key of a multivariate section", () => {
    expect(
      resolveSectionCandidates(
        {
          __resolveType: SECTION_MULTIVARIATE,
          variants: [
            { value: { __resolveType: BANNER }, rule: { __resolveType: "x" } },
            { value: { __resolveType: HEADER }, rule: { __resolveType: "y" } },
          ],
        },
        {},
      ),
    ).toEqual([BANNER, HEADER]);
  });

  it("returns null for a hidden section (single variant gated by never)", () => {
    expect(
      resolveSectionCandidates(
        {
          __resolveType: SECTION_MULTIVARIATE,
          variants: [
            {
              value: { __resolveType: BANNER },
              rule: { __resolveType: NEVER },
            },
          ],
        },
        {},
      ),
    ).toBeNull();
  });

  it("returns null when every variant is gated by never", () => {
    expect(
      resolveSectionCandidates(
        {
          __resolveType: SECTION_MULTIVARIATE,
          variants: [
            {
              value: { __resolveType: BANNER },
              rule: { __resolveType: NEVER },
            },
            {
              value: { __resolveType: HEADER },
              rule: { __resolveType: NEVER },
            },
          ],
        },
        {},
      ),
    ).toBeNull();
  });

  it("returns null for a multivariate with no variants", () => {
    expect(
      resolveSectionCandidates(
        { __resolveType: SECTION_MULTIVARIATE, variants: [] },
        {},
      ),
    ).toBeNull();
  });

  it("keeps never-gated variant keys when another variant can render", () => {
    // A never variant can still be forced via x-deco-matchers-override, so its
    // key stays an acceptable DOM match.
    expect(
      resolveSectionCandidates(
        {
          __resolveType: SECTION_MULTIVARIATE,
          variants: [
            {
              value: { __resolveType: BANNER },
              rule: { __resolveType: NEVER },
            },
            {
              value: { __resolveType: HEADER },
              rule: { __resolveType: "website/matchers/always.ts" },
            },
          ],
        },
        {},
      ),
    ).toEqual([BANNER, HEADER]);
  });

  it("returns null for a lazy wrapper around a hidden section", () => {
    expect(
      resolveSectionCandidates(
        {
          __resolveType: LAZY,
          section: {
            __resolveType: SECTION_MULTIVARIATE,
            variants: [
              {
                value: { __resolveType: BANNER },
                rule: { __resolveType: NEVER },
              },
            ],
          },
        },
        {},
      ),
    ).toBeNull();
  });
});
