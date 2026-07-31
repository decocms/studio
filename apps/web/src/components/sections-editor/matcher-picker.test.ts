import { describe, expect, it } from "bun:test";
import { extractMatchers, substringFilter } from "./matcher-picker";
import type { LiveMeta } from "./resolve-schema";

/**
 * Build a LiveMeta whose manifest blocks carry inline title/description/icon
 * metadata (resolveBlockSchemaMetadata reads those straight off the block
 * schema when there is no `$ref`).
 */
function metaWithBlocks(
  blocks: Record<
    string,
    Record<string, { title?: string; description?: string; icon?: string }>
  >,
): LiveMeta {
  return { manifest: { blocks }, schema: {} } as unknown as LiveMeta;
}

describe("extractMatchers", () => {
  it("does not list legacy $live compat aliases alongside canonical matchers", () => {
    const meta = metaWithBlocks({
      "website/matchers": {
        "website/matchers/userAgent.ts": {
          title: "User Agent",
          description: "Target users based on their web browser",
          icon: "world",
        },
        "website/matchers/random.ts": {
          title: "Random",
          description: "Target a percentage of the total traffic",
          icon: "arrow-split",
        },
        "website/matchers/always.ts": {
          title: "Always",
          description: "Target all users",
        },
      },
      // Legacy compat group: re-exports of the canonical matchers, so deco
      // generates identical title/description under a different resolveType.
      "$live/matchers": {
        "$live/matchers/MatchUserAgent.ts": {
          title: "User Agent",
          description: "Target users based on their web browser",
          icon: "world",
        },
        "$live/matchers/MatchRandom.ts": {
          title: "Random",
          description: "Target a percentage of the total traffic",
          icon: "arrow-split",
        },
        "$live/matchers/MatchAlways.ts": {
          title: "Always",
          description: "Target all users",
        },
      },
    });

    const matchers = extractMatchers(meta);
    const resolveTypes = matchers.map((m) => m.resolveType);

    // Canonical types only — no $live aliases.
    expect(resolveTypes).toEqual([
      "website/matchers/userAgent.ts",
      "website/matchers/random.ts",
    ]);
    // "always" is hardcoded in the picker; the capital-A alias must not leak.
    expect(resolveTypes.some((rt) => rt.toLowerCase().includes("always"))).toBe(
      false,
    );
  });

  it("dedupes a matcher registered under more than one block-type group", () => {
    const meta = metaWithBlocks({
      matchers: {
        "website/matchers/host.ts": {
          title: "Host",
          description: "Target users based on the domain",
          icon: "world-www",
        },
      },
      "website/matchers": {
        "website/matchers/host.ts": {
          title: "Host",
          description: "Target users based on the domain",
          icon: "world-www",
        },
      },
    });

    const matchers = extractMatchers(meta);
    expect(matchers.map((m) => m.resolveType)).toEqual([
      "website/matchers/host.ts",
    ]);
  });

  it("keeps non-compat matchers such as vtex/matchers/userSegment", () => {
    const meta = metaWithBlocks({
      "vtex/matchers": {
        "vtex/matchers/userSegment.ts": {
          title: "User Segment",
          description: "Segment users by authentication status",
          icon: "user-check",
        },
      },
    });

    const matchers = extractMatchers(meta);
    expect(matchers).toHaveLength(1);
    expect(matchers[0]?.resolveType).toBe("vtex/matchers/userSegment.ts");
    expect(matchers[0]?.title).toBe("User Segment");
  });
});

describe("substringFilter", () => {
  // The "Host" matcher's value used to fuzzy-match "random" because the letters
  // r-a-n-d-o-m appear as a subsequence in its description.
  const hostValue =
    "Host website/matchers/host.ts Target users based on the domain or subdomain they are accessing your site";
  const randomValue =
    "Random website/matchers/random.ts Target a percentage of the total traffic to do an A/B test";

  it("keeps matchers that actually contain the query", () => {
    expect(substringFilter(randomValue, "random")).toBeGreaterThan(0);
    expect(substringFilter(hostValue, "host")).toBeGreaterThan(0);
  });

  it("does not surface unrelated matchers via loose subsequence matching", () => {
    expect(substringFilter(hostValue, "random")).toBe(0);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(substringFilter(randomValue, "  RANDOM ")).toBeGreaterThan(0);
  });

  it("still matches text from the description (e.g. searching a keyword)", () => {
    expect(substringFilter(randomValue, "traffic")).toBeGreaterThan(0);
  });

  it("shows everything when the query is empty", () => {
    expect(substringFilter(hostValue, "")).toBeGreaterThan(0);
  });
});
