import { describe, expect, test } from "bun:test";
import {
  CLASSIC_MAX_UNCOLLAPSED_ITEMS,
  COMPACT_LAYOUT_MAX_UNCOLLAPSED_ITEMS,
  collapseBreadcrumbs,
  resolveBreadcrumbs,
  type BreadcrumbExtension,
  type BreadcrumbItem,
} from "./breadcrumb-model";

const LIMITS = [
  CLASSIC_MAX_UNCOLLAPSED_ITEMS,
  COMPACT_LAYOUT_MAX_UNCOLLAPSED_ITEMS,
];

const route: readonly BreadcrumbItem[] = [
  { key: "org", label: "Grupo Dass" },
  { key: "project", label: "Fila" },
  { key: "page", label: "Site Editor" },
];

describe("breadcrumb composition", () => {
  test("updates an anchor and adds selections without duplicating the route leaf", () => {
    let selected = "";
    const onSelect = () => {
      selected = "root";
    };
    const extensions = new Map<string, BreadcrumbExtension>([
      [
        "page",
        {
          after: "page",
          parent: { onSelect },
          items: [
            {
              key: "home",
              label: "Home",
              onSelect: () => {
                selected = "home";
              },
            },
            { key: "hero", label: "HeroSlideShow" },
          ],
        },
      ],
    ]);
    const items = resolveBreadcrumbs(route, extensions);
    expect(items.map((item) => item.label)).toEqual([
      "Grupo Dass",
      "Fila",
      "Site Editor",
      "Home",
      "HeroSlideShow",
    ]);
    items[2]?.onSelect?.();
    expect(selected).toBe("root");
    items[3]?.onSelect?.();
    expect(selected).toBe("home");
    expect(route[2]?.onSelect).toBeUndefined();
  });

  test("nested components compose by anchor regardless of registration order", () => {
    const extensions = new Map<string, BreadcrumbExtension>([
      [
        "home",
        { after: "home", items: [{ key: "hero", label: "HeroSlideShow" }] },
      ],
      ["page", { after: "page", items: [{ key: "home", label: "Home" }] }],
    ]);
    expect(
      resolveBreadcrumbs(route, extensions).map((item) => item.key),
    ).toEqual(["org", "project", "page", "home", "hero"]);
    extensions.delete("page");
    expect(resolveBreadcrumbs(route, extensions)).toEqual([...route]);
  });

  test("a title updates the route item and restores it when removed", () => {
    const extensions = new Map<string, BreadcrumbExtension>([
      ["page", { after: "page", parent: { label: "Renamed page" } }],
    ]);
    expect(resolveBreadcrumbs(route, extensions).at(-1)?.label).toBe(
      "Renamed page",
    );
    expect(resolveBreadcrumbs(route, new Map())).toEqual([...route]);
  });

  test("keys distinguish equal labels and reject duplicate or cyclic paths", () => {
    expect(
      resolveBreadcrumbs(
        [
          { key: "a", label: "Home" },
          { key: "b", label: "Home" },
        ],
        new Map(),
      ),
    ).toHaveLength(2);
    expect(() =>
      resolveBreadcrumbs(
        route,
        new Map([
          ["page", { after: "page", items: [{ key: "page", label: "Cycle" }] }],
        ]),
      ),
    ).toThrow("Duplicate breadcrumb key: page");
    expect(() =>
      resolveBreadcrumbs(
        [...route, { key: "org", label: "Duplicate" }],
        new Map(),
      ),
    ).toThrow("Duplicate breadcrumb key: org");
  });
});

describe("breadcrumb collapse", () => {
  test("a too-narrow container keeps the leaf and menus every ancestor, at either limit", () => {
    for (const max of LIMITS) {
      expect(
        collapseBreadcrumbs(["Org", "Library", "Folder"], true, max),
      ).toEqual([
        { type: "menu", items: ["Org", "Library"] },
        { type: "item", item: "Folder" },
      ]);
      expect(collapseBreadcrumbs(["Org", "Project"], true, max)).toEqual([
        { type: "menu", items: ["Org"] },
        { type: "item", item: "Project" },
      ]);
      expect(collapseBreadcrumbs(["Org"], true, max)).toEqual([
        { type: "item", item: "Org" },
      ]);
      expect(collapseBreadcrumbs([], true, max)).toEqual([]);
    }
  });

  test.each([0, 1, 2, 3, 4])(
    "the classic limit keeps a %i-item trail intact",
    (length) => {
      const items = Array.from({ length }, (_, index) => index);
      expect(
        collapseBreadcrumbs(items, false, CLASSIC_MAX_UNCOLLAPSED_ITEMS),
      ).toEqual(items.map((item) => ({ type: "item", item })));
    },
  );

  test.each([0, 1, 2, 3, 4, 5])(
    "the compact layout limit keeps a %i-item trail intact",
    (length) => {
      const items = Array.from({ length }, (_, index) => index);
      expect(
        collapseBreadcrumbs(items, false, COMPACT_LAYOUT_MAX_UNCOLLAPSED_ITEMS),
      ).toEqual(items.map((item) => ({ type: "item", item })));
    },
  );

  test("the compact layout renders a full five-item trail rather than hiding its middle", () => {
    const items = ["Org", "Project", "Site Editor", "Home", "HeroSlideShow"];
    expect(
      collapseBreadcrumbs(items, false, COMPACT_LAYOUT_MAX_UNCOLLAPSED_ITEMS),
    ).toEqual(items.map((item) => ({ type: "item", item })));
  });

  test("the classic limit collapses that same five-item trail", () => {
    expect(
      collapseBreadcrumbs(
        ["Org", "Project", "Site Editor", "Home", "HeroSlideShow"],
        false,
        CLASSIC_MAX_UNCOLLAPSED_ITEMS,
      ),
    ).toEqual([
      { type: "item", item: "Org" },
      { type: "menu", items: ["Project", "Site Editor"] },
      { type: "item", item: "Home" },
      { type: "item", item: "HeroSlideShow" },
    ]);
  });

  test("six items collapse to one menu and the immediate parent at either limit", () => {
    const items = [
      "Org",
      "Project",
      "Site Editor",
      "Home",
      "HeroSlideShow",
      "First slide",
    ];
    for (const max of LIMITS) {
      expect(collapseBreadcrumbs(items, false, max)).toEqual([
        { type: "item", item: "Org" },
        { type: "menu", items: ["Project", "Site Editor", "Home"] },
        { type: "item", item: "HeroSlideShow" },
        { type: "item", item: "First slide" },
      ]);
    }
  });

  test.each([false, true])(
    "preserves every item and its action in order at any depth and either limit (compact: %s)",
    (compact) => {
      const leaf = { key: "leaf", label: "Leaf", onSelect: () => -1 };
      for (const max of LIMITS) {
        for (let length = 0; length < 64; length++) {
          const items = Object.freeze([
            ...Array.from({ length }, (_, index) => ({
              key: String(index),
              label: "Repeated label",
              onSelect: () => index,
            })),
            leaf,
          ]);
          const entries = collapseBreadcrumbs(items, compact, max);
          const expanded = entries.flatMap((entry) =>
            entry.type === "menu" ? entry.items : [entry.item],
          );
          expect(expanded).toEqual([...items]);
          items.forEach((item, index) => expect(expanded[index]).toBe(item));
          expect(
            entries.filter((entry) => entry.type === "menu").length,
          ).toBeLessThanOrEqual(1);
          expect(entries.at(-1)).toEqual({ type: "item", item: leaf });
        }
      }
    },
  );

  test("the limit defaults to the classic one when a caller omits it", () => {
    const items = ["Org", "Project", "Site Editor", "Home", "HeroSlideShow"];
    expect(collapseBreadcrumbs(items)).toEqual(
      collapseBreadcrumbs(items, false, CLASSIC_MAX_UNCOLLAPSED_ITEMS),
    );
  });
});
