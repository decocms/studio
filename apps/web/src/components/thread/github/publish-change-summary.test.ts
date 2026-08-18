import { describe, expect, it } from "bun:test";
import {
  blockKeyFromDiffPath,
  buildAutoNote,
  buildContentSummaryForLlm,
  humanizeFieldName,
  revertFieldAtPath,
  sectionDisplayName,
  summarizePublishChanges,
} from "./publish-change-summary";
import type { GitDiffResult } from "./sandbox-git-api";

const HOME_KEY = "pages-home-c4bcbfb771e9";
const HOME_PATH = `.deco/blocks/${encodeURIComponent(HOME_KEY)}.json`;

function pageJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    __resolveType: "website/pages/Page.tsx",
    name: "Home",
    path: "/",
    sections: [
      {
        __resolveType: "site/sections/Hero.tsx",
        title: "Summer Sale",
        backgroundImage: { src: "/images/summer.webp" },
      },
      { __resolveType: "site/sections/Footer.tsx", links: ["a", "b"] },
    ],
    ...overrides,
  });
}

function diffOf(entries: GitDiffResult["diffs"]): GitDiffResult {
  return { diffs: entries };
}

describe("blockKeyFromDiffPath", () => {
  it("maps block files at the repo root and under a package path", () => {
    expect(blockKeyFromDiffPath(HOME_PATH)).toBe(HOME_KEY);
    expect(blockKeyFromDiffPath(`apps/site/${HOME_PATH}`)).toBe(HOME_KEY);
  });

  it("decodes percent-encoded stems into the block key", () => {
    expect(blockKeyFromDiffPath(".deco/blocks/Compre%20Junto.json")).toBe(
      "Compre Junto",
    );
  });

  it("returns null for non-block files", () => {
    expect(blockKeyFromDiffPath("src/index.ts")).toBeNull();
    expect(blockKeyFromDiffPath(".deco/blocks.gen.json")).toBeNull();
    expect(blockKeyFromDiffPath(".deco/blocks/nested/x.json")).toBeNull();
  });
});

describe("summarizePublishChanges", () => {
  it("returns an empty summary for a null diff", () => {
    const summary = summarizePublishChanges(null);
    expect(summary.count).toBe(0);
    expect(summary.pages).toEqual([]);
  });

  it("classifies an edited page with section-level field changes", () => {
    const summary = summarizePublishChanges(
      diffOf({
        [HOME_PATH]: {
          from: pageJson(),
          to: pageJson({
            sections: [
              {
                __resolveType: "site/sections/Hero.tsx",
                title: "Black Friday Sale",
                backgroundImage: { src: "/images/bf.webp" },
              },
              { __resolveType: "site/sections/Footer.tsx", links: ["a", "b"] },
            ],
          }),
        },
      }),
    );

    expect(summary.count).toBe(1);
    const page = summary.pages[0]!;
    expect(page.kind).toBe("page");
    expect(page.name).toBe("Home");
    expect(page.pagePath).toBe("/");
    expect(page.status).toBe("edited");
    expect(page.filepaths).toEqual([HOME_PATH]);
    expect(page.sections).toHaveLength(1);
    const hero = page.sections[0]!;
    expect(hero.name).toBe("Hero");
    expect(hero.fields.map((f) => f.label).sort()).toEqual([
      "Background image",
      "Title",
    ]);
    const title = hero.fields.find((f) => f.label === "Title")!;
    expect(title.from).toBe("Summer Sale");
    expect(title.to).toBe("Black Friday Sale");
    expect(title.path).toEqual(["sections", 0, "title"]);
  });

  it("classifies new and removed pages without section noise", () => {
    const summary = summarizePublishChanges(
      diffOf({
        [".deco/blocks/pages-black--friday-9f8e.json"]: {
          from: null,
          to: JSON.stringify({
            __resolveType: "$live/pages/LivePage.tsx",
            name: "Black Friday",
            path: "/black-friday",
            sections: [],
          }),
        },
        [".deco/blocks/pages-old-1234abcd.json"]: {
          from: JSON.stringify({
            __resolveType: "website/pages/Page.tsx",
            name: "Old",
            path: "/old",
            sections: [],
          }),
          to: null,
        },
      }),
    );

    expect(summary.pages.map((p) => [p.name, p.status])).toEqual([
      ["Black Friday", "new"],
      ["Old", "removed"],
    ]);
    expect(summary.pages.every((p) => p.sections.length === 0)).toBe(true);
  });

  it("classifies a non-page block with a shallow field diff", () => {
    const summary = summarizePublishChanges(
      diffOf({
        [".deco/blocks/Header.json"]: {
          from: JSON.stringify({
            __resolveType: "site/sections/Header.tsx",
            links: ["Home"],
          }),
          to: JSON.stringify({
            __resolveType: "site/sections/Header.tsx",
            links: ["Home", "Black Friday"],
          }),
        },
      }),
    );

    expect(summary.blocks).toHaveLength(1);
    const header = summary.blocks[0]!;
    expect(header.kind).toBe("block");
    expect(header.status).toBe("edited");
    expect(header.sections[0]!.fields.map((f) => f.label)).toEqual(["Links"]);
  });

  it("flags the site app block", () => {
    const summary = summarizePublishChanges(
      diffOf({
        [".deco/blocks/site.json"]: {
          from: JSON.stringify({ __resolveType: "site/apps/site.ts", a: 1 }),
          to: JSON.stringify({ __resolveType: "site/apps/site.ts", a: 2 }),
        },
      }),
    );
    expect(summary.blocks[0]!.isSiteApp).toBe(true);
  });

  it("routes non-block and unparsable-JSON files to other, never hiding them", () => {
    const summary = summarizePublishChanges(
      diffOf({
        ["src/index.ts"]: { from: "a", to: "b" },
        [".deco/blocks/broken.json"]: { from: "{not json", to: "{still not" },
      }),
    );
    expect(summary.other.map((c) => c.name).sort()).toEqual([
      "broken.json",
      "index.ts",
    ]);
    expect(summary.count).toBe(2);
  });

  it("separates generated artifacts out of the visible count", () => {
    const summary = summarizePublishChanges(
      diffOf({
        [".deco/blocks.gen.json"]: { from: "a", to: "b" },
        ["static/tailwind.css"]: { from: "a", to: "b" },
        [HOME_PATH]: { from: null, to: pageJson() },
      }),
    );
    expect(summary.generated.sort()).toEqual([
      ".deco/blocks.gen.json",
      "static/tailwind.css",
    ]);
    expect(summary.count).toBe(1);
  });

  it("disambiguates duplicate page names by keeping both cards", () => {
    const other = pageJson({ path: "/home-2" });
    const summary = summarizePublishChanges(
      diffOf({
        [HOME_PATH]: { from: null, to: pageJson() },
        [".deco/blocks/pages-home-ffff0000.json"]: { from: null, to: other },
      }),
    );
    expect(summary.pages).toHaveLength(2);
    expect(new Set(summary.pages.map((p) => p.pagePath)).size).toBe(2);
  });

  it("walks multivariate section paths for per-field revert", () => {
    const variant = (title: string) => ({
      __resolveType: "website/pages/Page.tsx",
      name: "Home",
      path: "/",
      sections: {
        variants: [
          {
            rule: {},
            value: [{ __resolveType: "site/sections/Hero.tsx", title }],
          },
        ],
      },
    });
    const summary = summarizePublishChanges(
      diffOf({
        [HOME_PATH]: {
          from: JSON.stringify(variant("Before")),
          to: JSON.stringify(variant("After")),
        },
      }),
    );
    const field = summary.pages[0]!.sections[0]!.fields[0]!;
    expect(field.path).toEqual([
      "sections",
      "variants",
      0,
      "value",
      0,
      "title",
    ]);
  });

  it("reports page-level settings changes as their own pseudo-section", () => {
    const summary = summarizePublishChanges(
      diffOf({
        [HOME_PATH]: {
          from: pageJson(),
          to: pageJson({ path: "/home" }),
        },
      }),
    );
    const settings = summary.pages[0]!.sections.find(
      (s) => s.name === "Page settings",
    )!;
    expect(settings.fields.map((f) => f.label)).toEqual(["Path"]);
  });
});

describe("buildAutoNote", () => {
  it("composes edited, added and block segments in content language", () => {
    const summary = summarizePublishChanges(
      diffOf({
        [HOME_PATH]: {
          from: pageJson(),
          to: pageJson({
            sections: [
              { __resolveType: "site/sections/Hero.tsx", title: "New" },
              { __resolveType: "site/sections/Footer.tsx", links: [] },
            ],
          }),
        },
        [".deco/blocks/pages-black--friday-9f8e.json"]: {
          from: null,
          to: JSON.stringify({
            __resolveType: "website/pages/Page.tsx",
            name: "Black Friday",
            path: "/black-friday",
            sections: [],
          }),
        },
        [".deco/blocks/Header.json"]: {
          from: JSON.stringify({ __resolveType: "x", links: [] }),
          to: JSON.stringify({ __resolveType: "x", links: ["a"] }),
        },
      }),
    );
    expect(buildAutoNote(summary)).toBe(
      "Updated Home (Hero, Footer), added the Black Friday page and changed Header",
    );
  });

  it("returns empty for an empty summary and never mentions git", () => {
    expect(buildAutoNote(summarizePublishChanges(diffOf({})))).toBe("");
    const note = buildAutoNote(
      summarizePublishChanges(diffOf({ ["src/a.ts"]: { from: "1", to: "2" } })),
    );
    expect(note).toBe("Changed 1 file");
    expect(note.toLowerCase()).not.toContain("commit");
  });
});

describe("buildContentSummaryForLlm", () => {
  it("names pages, sections and fields instead of file paths", () => {
    const summary = summarizePublishChanges(
      diffOf({
        [HOME_PATH]: {
          from: pageJson(),
          to: pageJson({
            sections: [
              { __resolveType: "site/sections/Hero.tsx", title: "New" },
              { __resolveType: "site/sections/Footer.tsx", links: ["a", "b"] },
            ],
          }),
        },
      }),
    );
    const text = buildContentSummaryForLlm(summary);
    expect(text).toContain('Page "Home" (/) edited');
    expect(text).toContain("Hero (Title, Background image)");
    expect(text).not.toContain(".deco/blocks");
  });
});

describe("revertFieldAtPath", () => {
  const to = {
    __resolveType: "website/pages/Page.tsx",
    sections: [{ __resolveType: "site/sections/Hero.tsx", title: "After" }],
  };

  it("restores a field to its from-side value without mutating the input", () => {
    const from = {
      sections: [{ __resolveType: "site/sections/Hero.tsx", title: "Before" }],
    };
    const updated = revertFieldAtPath(to, from, ["sections", 0, "title"])!;
    expect((updated.sections as Record<string, unknown>[])[0]!.title).toBe(
      "Before",
    );
    expect((to.sections as Record<string, unknown>[])[0]!.title).toBe("After");
  });

  it("deletes a field that did not exist before", () => {
    const updated = revertFieldAtPath(to, {}, ["sections", 0, "title"])!;
    expect("title" in (updated.sections as Record<string, unknown>[])[0]!).toBe(
      false,
    );
  });

  it("returns null when the path no longer resolves", () => {
    expect(revertFieldAtPath(to, null, ["sections", 5, "title"])).toBeNull();
    expect(revertFieldAtPath(to, null, [])).toBeNull();
  });
});

describe("humanizeFieldName / sectionDisplayName", () => {
  it("humanizes camelCase, snake_case and kebab-case", () => {
    expect(humanizeFieldName("backgroundImage")).toBe("Background image");
    expect(humanizeFieldName("cta_link")).toBe("Cta link");
    expect(humanizeFieldName("hero-title")).toBe("Hero title");
  });

  it("derives section names from resolve types with an index fallback", () => {
    expect(
      sectionDisplayName({ __resolveType: "site/sections/Hero.tsx" }, 0),
    ).toBe("Hero");
    expect(sectionDisplayName({}, 2)).toBe("Section 3");
  });
});
