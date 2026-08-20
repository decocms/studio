import { describe, expect, it } from "bun:test";
import {
  blockKeyFromDiffPath,
  buildAutoNote,
  countPageSections,
  humanizeFieldName,
  resolveVersionNote,
  sectionDisplayName,
  summarizePublishChanges,
  summarizePublishManifest,
} from "./publish-change-summary";
import { changeId } from "./cms-publish-change-card";
import type { GitChangedFile, GitDiffResult } from "./sandbox-git-api";

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

  it("walks multivariate section paths", () => {
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

describe("summarizePublishManifest", () => {
  const HEADER_KEY = "Header";
  const HEADER_PATH = `.deco/blocks/${HEADER_KEY}.json`;
  const headerJson = JSON.stringify({ name: "Site header", links: ["a"] });

  const FILES: GitChangedFile[] = [
    { path: HOME_PATH, status: "modified" },
    { path: HEADER_PATH, status: "modified" },
    { path: "static/tailwind.css", status: "modified" },
    { path: "README.md", status: "added" },
  ];

  const LOOKUP = {
    [HOME_KEY]: JSON.parse(pageJson()) as Record<string, unknown>,
    [HEADER_KEY]: JSON.parse(headerJson) as Record<string, unknown>,
  };

  const BODIES: GitDiffResult = {
    diffs: {
      [HOME_PATH]: { from: pageJson(), to: pageJson({ name: "Home Page" }) },
      [HEADER_PATH]: { from: headerJson, to: headerJson },
      "static/tailwind.css": { from: "a{}", to: "b{}" },
      "README.md": { from: null, to: "# hi" },
    },
  };

  it("builds the full card list from paths alone, before any body is fetched", () => {
    const summary = summarizePublishManifest({ files: FILES, lookup: LOOKUP });
    expect(summary.count).toBe(3);
    expect(summary.pages.map((p) => p.name)).toEqual(["Home"]);
    expect(summary.pages[0]?.pagePath).toBe("/");
    expect(summary.blocks.map((b) => b.name)).toEqual(["Site header"]);
    expect(summary.other.map((o) => o.name)).toEqual(["README.md"]);
    expect(summary.generated).toEqual(["static/tailwind.css"]);
  });

  it("keeps identity, order, kind and status IDENTICAL once bodies land", () => {
    const manifestOnly = summarizePublishManifest({
      files: FILES,
      lookup: LOOKUP,
    });
    const enriched = summarizePublishManifest({
      files: FILES,
      lookup: LOOKUP,
      diff: BODIES,
    });

    const shape = (s: typeof manifestOnly) => ({
      count: s.count,
      ids: [...s.pages, ...s.blocks, ...s.other].map(changeId),
      kinds: [...s.pages, ...s.blocks, ...s.other].map((c) => c.kind),
      statuses: [...s.pages, ...s.blocks, ...s.other].map((c) => c.status),
    });
    expect(shape(enriched)).toEqual(shape(manifestOnly));
  });

  it("adds section sub-lines only once bodies land", () => {
    const before = summarizePublishManifest({ files: FILES, lookup: LOOKUP });
    const after = summarizePublishManifest({
      files: FILES,
      lookup: LOOKUP,
      diff: BODIES,
    });
    expect(before.pages[0]?.sections).toEqual([]);
    expect(after.pages[0]?.sections.length).toBeGreaterThan(0);
  });

  it("names a card from the block key when the head decofile has no entry", () => {
    const summary = summarizePublishManifest({
      files: [{ path: HEADER_PATH, status: "removed" }],
      lookup: {},
    });
    expect(summary.blocks[0]?.name).toBe("Header");
    expect(summary.blocks[0]?.status).toBe("removed");
  });

  it("classifies a removed page by its key convention, with no content to read", () => {
    const summary = summarizePublishManifest({
      files: [{ path: HOME_PATH, status: "removed" }],
      lookup: {},
    });
    expect(summary.pages).toHaveLength(1);
    expect(summary.pages[0]?.name).toBe("home");
  });

  it("does NOT re-group a card when a late body disagrees with the head shape", () => {
    const files: GitChangedFile[] = [{ path: HOME_PATH, status: "removed" }];
    const withBodies = summarizePublishManifest({
      files,
      lookup: {},
      diff: { diffs: { [HOME_PATH]: { from: pageJson(), to: null } } },
    });
    expect(withBodies.pages).toHaveLength(1);
    expect(withBodies.blocks).toHaveLength(0);
    expect(withBodies.pages[0]?.name).toBe("Home");
  });

  it("sorts by path so a card cannot move when its name resolves", () => {
    const files: GitChangedFile[] = [
      { path: ".deco/blocks/Zebra.json", status: "modified" },
      { path: ".deco/blocks/Alpha.json", status: "modified" },
    ];
    const bare = summarizePublishManifest({ files, lookup: {} });
    const named = summarizePublishManifest({
      files,
      lookup: {
        Zebra: { name: "AAA first now" },
        Alpha: { name: "ZZZ last now" },
      },
    });
    expect(bare.blocks.map(changeId)).toEqual(named.blocks.map(changeId));
  });

  it("counts a NEW page's sections from the head decofile, before bodies land", () => {
    const summary = summarizePublishManifest({
      files: [{ path: HOME_PATH, status: "added" }],
      lookup: LOOKUP,
    });
    // Rendered as "New page with N sections" — N must not read 0 and correct
    // itself once the body arrives.
    expect(countPageSections(summary.pages[0]?.toJson ?? null)).toBe(2);
  });

  it("counts nothing when nothing changed", () => {
    expect(summarizePublishManifest({ files: [], lookup: {} }).count).toBe(0);
  });
});

describe("resolveVersionNote", () => {
  it("derives the note until the author types", () => {
    expect(resolveVersionNote(null, "Updated Home")).toBe("Updated Home");
  });

  it("pins the author's text once typed", () => {
    expect(resolveVersionNote("Mine", "Updated Home")).toBe("Mine");
  });

  it("keeps a deliberately cleared field empty — never refills it", () => {
    expect(resolveVersionNote("", "Updated Home")).toBe("");
  });
});
