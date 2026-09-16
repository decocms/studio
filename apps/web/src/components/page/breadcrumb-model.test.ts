import { describe, expect, test } from "bun:test";
import {
  collapseBreadcrumbs,
  resolveBreadcrumbs,
  type BreadcrumbExtension,
  type BreadcrumbItem,
} from "./breadcrumb-model";

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
  test("compact trails keep the leaf and put every ancestor in one menu", () => {
    expect(collapseBreadcrumbs(["Org", "Library", "Folder"], true)).toEqual({
      start: [],
      collapsed: ["Org", "Library"],
      end: ["Folder"],
    });
    expect(collapseBreadcrumbs(["Org", "Project"], true)).toEqual({
      start: [],
      collapsed: ["Org"],
      end: ["Project"],
    });
    expect(collapseBreadcrumbs(["Org"], true)).toEqual({
      start: [],
      collapsed: [],
      end: ["Org"],
    });
  });
  test.each([0, 1, 2, 3, 4])("keeps a %i-item trail intact", (length) => {
    const items = Array.from({ length }, (_, index) => index);
    expect(collapseBreadcrumbs(items)).toEqual({
      start: [],
      collapsed: [],
      end: items,
    });
  });

  test("collapses Project and Site Editor together, keeping the page and block", () => {
    expect(
      collapseBreadcrumbs([
        "Org",
        "Project",
        "Site Editor",
        "Home",
        "HeroSlideShow",
      ]),
    ).toEqual({
      start: ["Org"],
      collapsed: ["Project", "Site Editor"],
      end: ["Home", "HeroSlideShow"],
    });
  });

  test("keeps one ordered menu and the immediate parent at any depth", () => {
    const items = [
      "Org",
      "Project",
      "Site Editor",
      "Home",
      "HeroSlideShow",
      "First slide",
    ];
    const { start, collapsed, end } = collapseBreadcrumbs(items);
    expect(collapsed).toEqual(["Project", "Site Editor", "Home"]);
    expect(end).toEqual(["HeroSlideShow", "First slide"]);
    expect([...start, ...collapsed, ...end]).toEqual(items);
  });
});
