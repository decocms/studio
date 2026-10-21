import { describe, expect, it } from "bun:test";
import {
  blockKeyFromDiffPath,
  buildAutoNote,
  humanizeFieldName,
  publishChangeDigest,
  resolveVersionNote,
  maskSecrets,
  namedRuleBlockOfChange,
  SECRET_MASK,
  sectionDisplayName,
  summarizeContentChanges,
  summarizePublishChanges,
  summarizePublishManifest,
} from "./publish-change-summary";
import { changeId } from "./cms-publish-change-card";
import type { GitChangedFile, GitDiffResult } from "./sandbox-git-api";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { blocksUsingMissingNamedRules } from "@/components/sections-editor/named-rule-uses";

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

  it("walks v8 multivariate section paths, one lazy value deeper", () => {
    const variant = (title: string) => ({
      __resolveType: "website/pages/Page.tsx",
      name: "Home",
      path: "/",
      sections: {
        __resolveType: "multivariate",
        variants: [
          {
            rule: { __resolveType: "always" },
            value: {
              __resolveType: "lazy",
              value: [{ __resolveType: "hero", title }],
            },
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
      (s) => s.kind === "settings",
    )!;
    expect(settings.fields.map((f) => f.label)).toEqual(["Path"]);
  });
});

describe("publishChangeDigest", () => {
  /** Every section here resolves to the same wrapper name — the exact shape
   *  that used to render twenty identical "Lazy — Section" rows. */
  function lazyPage(titles: string[]): string {
    return JSON.stringify({
      __resolveType: "website/pages/Page.tsx",
      name: "Home ETC",
      path: "/farm-etc",
      sections: titles.map((title) => ({
        __resolveType: "website/sections/Rendering/Lazy.tsx",
        section: { __resolveType: title },
      })),
    });
  }

  it("counts changed sections instead of naming them", () => {
    const summary = summarizePublishChanges(
      diffOf({
        [HOME_PATH]: {
          from: lazyPage(["a", "b", "c"]),
          to: lazyPage(["a", "B!", "C!"]),
        },
      }),
    );
    expect(publishChangeDigest(summary.pages[0]!)).toEqual({
      newPageSections: null,
      sections: 2,
      settings: false,
      fields: 0,
    });
  });

  it("reports page settings separately from the section count", () => {
    const summary = summarizePublishChanges(
      diffOf({
        [HOME_PATH]: { from: pageJson(), to: pageJson({ path: "/home" }) },
      }),
    );
    const digest = publishChangeDigest(summary.pages[0]!);
    expect(digest.sections).toBe(0);
    expect(digest.settings).toBe(true);
  });

  it("counts fields, not sections, for a block card", () => {
    const path = ".deco/blocks/Header.json";
    const summary = summarizePublishChanges(
      diffOf({
        [path]: {
          from: JSON.stringify({ name: "Header", links: ["a"], logo: "x" }),
          to: JSON.stringify({ name: "Header", links: ["b"], logo: "y" }),
        },
      }),
    );
    const digest = publishChangeDigest(summary.blocks[0]!);
    expect(digest.fields).toBe(2);
    expect(digest.sections).toBe(0);
  });

  it("sizes a new page by its sections and skips the changed-section tally", () => {
    const summary = summarizePublishChanges(
      diffOf({ [HOME_PATH]: { from: null, to: pageJson() } }),
    );
    expect(publishChangeDigest(summary.pages[0]!)).toEqual({
      newPageSections: 2,
      sections: 0,
      settings: false,
      fields: 0,
    });
  });

  it("reports nothing for a removed page", () => {
    const summary = summarizePublishChanges(
      diffOf({ [HOME_PATH]: { from: pageJson(), to: null } }),
    );
    expect(publishChangeDigest(summary.pages[0]!)).toEqual({
      newPageSections: null,
      sections: 0,
      settings: false,
      fields: 0,
    });
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

  it("collapses long name lists and fits the note in a title", () => {
    const removed = Object.fromEntries(
      Array.from({ length: 93 }, (_, i) => [
        `.deco/blocks/pages-campaign-${i}-${i}.json`,
        {
          from: JSON.stringify({
            __resolveType: "website/pages/Page.tsx",
            name: `Campaign ${i} ${"x".repeat(i === 0 ? 300 : 0)}`.trim(),
            path: `/campaign-${i}`,
            sections: [],
          }),
          to: null,
        },
      ]),
    );
    const note = buildAutoNote(summarizePublishChanges(diffOf(removed)));
    expect(note).toEndWith("…");
    expect(note.length).toBeLessThanOrEqual(255);

    const fewer = Object.fromEntries(Object.entries(removed).slice(1, 6));
    expect(buildAutoNote(summarizePublishChanges(diffOf(fewer)))).toMatch(
      /^Removed the Campaign \d+, Campaign \d+, Campaign \d+ and 2 more pages$/,
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
    expect(publishChangeDigest(summary.pages[0]!).newPageSections).toBe(2);
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

describe("summarizeContentChanges (a v8 source's changes.list)", () => {
  const page = (overrides: Record<string, unknown> = {}) =>
    JSON.parse(pageJson(overrides)) as Record<string, unknown>;
  const header = { __resolveType: "site/sections/Header.tsx", logo: "a.png" };
  const changes = {
    [HOME_KEY]: { kind: "set", version: "v1", baseVersion: "b1" },
    "pages-promo-1": { kind: "set", version: "v2", baseVersion: null },
    Header: { kind: "set", version: "v3", baseVersion: "b3" },
    "pages-old-2": { kind: "delete", version: null, baseVersion: "b4" },
  } as const;

  it("lists every change by entry name, with the version its discard is guarded by", () => {
    const summary = summarizeContentChanges({
      changes,
      lookup: {
        [HOME_KEY]: page(),
        "pages-promo-1": page({ name: "Promo", path: "/promo" }),
        Header: header,
      },
    });
    expect(summary.count).toBe(4);
    expect(summary.pages.map((p) => [p.name, p.status, p.entry])).toEqual([
      ["Home", "edited", { name: HOME_KEY, version: "v1" }],
      ["old-2", "removed", { name: "pages-old-2", version: null }],
      ["Promo", "new", { name: "pages-promo-1", version: "v2" }],
    ]);
    expect(summary.blocks.map((b) => [b.blockKey, b.status])).toEqual([
      ["Header", "edited"],
    ]);
    // No file paths: the entry is the card's identity.
    expect(summary.pages.map(changeId)).toEqual([
      HOME_KEY,
      "pages-old-2",
      "pages-promo-1",
    ]);
    expect(summary.pages.every((p) => p.filepaths.length === 0)).toBe(true);
  });

  it("both sides add what changed inside; they never move a card", () => {
    const lookup = { [HOME_KEY]: page({ name: "Home" }), Header: header };
    const before = summarizeContentChanges({ changes, lookup });
    const sides = {
      entries: {
        [HOME_KEY]: {
          kind: "set" as const,
          before: page(),
          after: page({
            sections: [
              {
                __resolveType: "site/sections/Hero.tsx",
                title: "Winter Sale",
                backgroundImage: { src: "/images/summer.webp" },
              },
              { __resolveType: "site/sections/Footer.tsx", links: ["a", "b"] },
            ],
          }),
          version: "v1",
          baseVersion: "b1",
        },
        Header: {
          kind: "set" as const,
          before: header,
          after: { ...header, logo: "b.png" },
          version: "v3",
          baseVersion: "b3",
        },
      },
      diagnostics: [],
    };
    const after = summarizeContentChanges({ changes, lookup, sides });
    expect(after.pages.map(changeId)).toEqual(before.pages.map(changeId));
    const home = after.pages.find((p) => p.blockKey === HOME_KEY)!;
    expect(home.sections.map((s) => s.name)).toEqual(["Hero"]);
    expect(after.blocks[0]!.sections[0]!.fields).toMatchObject([
      { label: "Logo", from: "a.png", to: "b.png" },
    ]);
  });

  it("compares secrets but never shows them", () => {
    const secret = (ciphertext: string) => ({
      __resolveType: "secret",
      ciphertext,
    });
    const settings = (key: unknown) => ({
      __resolveType: "site/apps/site.ts",
      apiKey: key,
    });
    const summary = summarizeContentChanges({
      changes: { Settings: { kind: "set", version: "v", baseVersion: "b" } },
      sides: {
        entries: {
          Settings: {
            kind: "set",
            before: settings(secret("v1.old")),
            after: settings(secret("v1.new")),
            version: "v",
            baseVersion: "b",
          },
        },
        diagnostics: [],
      },
    });
    const card = summary.blocks[0]!;
    expect(card.sections[0]!.fields).toEqual([
      {
        label: "Api key",
        path: ["apiKey"],
        from: secret(SECRET_MASK),
        to: secret(SECRET_MASK),
      },
    ]);
    expect(JSON.stringify(card)).not.toContain("v1.old");
    expect(JSON.stringify(card)).not.toContain("v1.new");
  });

  it("says which side can't be shown", () => {
    const summary = summarizeContentChanges({
      changes: { Broken: { kind: "set", version: "v", baseVersion: "b" } },
      sides: {
        entries: {
          Broken: {
            kind: "set",
            before: null,
            after: { v: 2 },
            version: "v",
            baseVersion: "b",
          },
        },
        diagnostics: [
          {
            file: "Broken.json",
            kind: "invalid-json",
            message: "bad",
            side: "before",
          },
        ],
      },
    });
    expect(summary.blocks[0]!.unreadable).toEqual(["before"]);
  });

  it("reads a v8 page (the built-in `page`, named by the schema) as a page, through its lazy page variants", () => {
    const meta = {
      manifest: { blocks: { pages: { page: {} } } },
    } as unknown as LiveMeta;
    const lazy = (value: unknown) => ({ __resolveType: "lazy", value });
    const intro = { __resolveType: "intro-statement", text: "Three" };
    const v8Home = (sections: unknown) => ({
      __resolveType: "page",
      name: "Home Page",
      path: "/",
      sections,
    });
    const pageVariants = (second: Record<string, unknown>) => ({
      __resolveType: "multivariate",
      variants: [
        {
          rule: { __resolveType: "always" },
          value: lazy([{ __resolveType: "Header" }, intro]),
        },
        {
          rule: { __resolveType: "always" },
          value: lazy([{ __resolveType: "Header" }, second]),
        },
      ],
    });
    const before = v8Home(pageVariants(intro));
    const after = v8Home(pageVariants({ ...intro, text: "Variant two" }));
    const input: Parameters<typeof summarizeContentChanges>[0] = {
      changes: {
        "pages-home": { kind: "set", version: "v", baseVersion: "b" },
      },
      sides: {
        entries: {
          "pages-home": {
            kind: "set",
            before,
            after,
            version: "v",
            baseVersion: "b",
          },
        },
        diagnostics: [],
      },
      lookup: { "pages-home": after },
    };

    const summary = summarizeContentChanges({ ...input, meta });
    expect(summary.blocks).toEqual([]);
    const card = summary.pages[0]!;
    expect([card.name, card.pagePath]).toEqual(["Home Page", "/"]);
    const edited = card.sections.find((s) => s.status === "edited")!;
    expect(edited.fields.map((f) => f.path)).toEqual([
      ["sections", "variants", 1, "value", "value", 1, "text"],
    ]);
    // Without the schema `page` is no page type: one global section.
    expect(summarizeContentChanges(input).pages).toEqual([]);
  });

  it("flags a page whose rule names a test the draft no longer has (a discard went through)", () => {
    const builtIn = { $ref: "#/definitions/x", namespace: "deco" };
    const meta = {
      manifest: {
        blocks: {
          matchers: { always: builtIn, experiment: builtIn, date: builtIn },
          loaders: { multivariate: builtIn, lazy: builtIn },
          content: { "split-traffic": builtIn, "date-windows": builtIn },
          pages: { page: builtIn },
        },
      },
      schema: {},
    } as unknown as LiveMeta;
    const promo = {
      __resolveType: "page",
      name: "Promo",
      path: "/promo",
      sections: {
        __resolveType: "multivariate",
        variants: [
          { rule: { __resolveType: "always" }, value: [] },
          { rule: { __resolveType: "experiment", name: "hero" }, value: [] },
        ],
      },
    };
    // "A/B tests" was discarded: the page still names "hero", which is gone.
    const lookup = {
      "pages-promo": promo,
      experiments: { __resolveType: "split-traffic" },
    };
    const summary = summarizeContentChanges({
      changes: {
        "pages-promo": { kind: "set", version: "v", baseVersion: null },
      },
      lookup,
      meta,
      missingRules: blocksUsingMissingNamedRules(lookup, meta),
    });
    expect(summary.pages[0]!.missingRules).toEqual(["experiments"]);
    // With the test there, nothing is flagged.
    const withTest = {
      ...lookup,
      experiments: { __resolveType: "split-traffic", hero: 50 },
    };
    expect(
      summarizeContentChanges({
        changes: {
          "pages-promo": { kind: "set", version: "v", baseVersion: null },
        },
        lookup: withTest,
        meta,
        missingRules: blocksUsingMissingNamedRules(withTest, meta),
      }).pages[0]!.missingRules,
    ).toBeUndefined();
  });
});

describe("maskSecrets", () => {
  it("masks v8 secret blocks and v7 secret loaders, anywhere in a value", () => {
    expect(
      maskSecrets({
        a: [{ __resolveType: "secret", ciphertext: "v1.x" }],
        b: { __resolveType: "website/loaders/secret.ts", encrypted: "0a1b" },
        c: "plain",
      }),
    ).toEqual({
      a: [{ __resolveType: "secret", ciphertext: SECRET_MASK }],
      b: { __resolveType: "website/loaders/secret.ts", encrypted: SECRET_MASK },
      c: "plain",
    });
  });
});

describe("namedRuleBlockOfChange", () => {
  const block = (json: Record<string, unknown> | null, before = json) => ({
    kind: "block" as const,
    toJson: json,
    fromJson: before,
  });
  it("names the A/B tests and campaigns blocks by their type", () => {
    expect(
      namedRuleBlockOfChange(block({ __resolveType: "split-traffic", a: 50 })),
    ).toBe("experiments");
    expect(
      namedRuleBlockOfChange(block({ __resolveType: "date-windows" })),
    ).toBe("campaigns");
    // Deleted in the draft: the published side still says what it was.
    expect(
      namedRuleBlockOfChange(block(null, { __resolveType: "date-windows" })),
    ).toBe("campaigns");
  });
  it("leaves every other block, and pages, as they were", () => {
    expect(namedRuleBlockOfChange(block({ __resolveType: "Header" }))).toBe(
      null,
    );
    // A v7 site's own block named experiments, of another type.
    expect(
      namedRuleBlockOfChange(block({ __resolveType: "site/loaders/x.ts" })),
    ).toBe(null);
    expect(
      namedRuleBlockOfChange({
        kind: "page",
        toJson: { __resolveType: "split-traffic" },
        fromJson: null,
      }),
    ).toBe(null);
  });
});
