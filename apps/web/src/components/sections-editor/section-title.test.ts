import { describe, expect, test } from "bun:test";
import {
  getSectionDisplayTitle,
  resolveSectionTitleTemplate,
} from "./section-title";
import type { LiveMeta } from "./resolve-schema";

const DEPARTMENT_SHOP_RT = "site/sections/DepartmentShop.tsx";
const PLAIN_RT = "site/sections/Hero.tsx";
const LAZY = "website/sections/Rendering/Lazy.tsx";
const MV = "website/flags/multivariate/section.ts";
const NEVER = "website/matchers/never.ts";

const TITLE_TPL =
  "Department Shop {{#kicker}}{{#title}}—{{/title}}{{/kicker}} {{#kicker}}{{kicker}}{{/kicker}} {{#title}}{{.}} {{/title}}";

function meta(): LiveMeta {
  return {
    manifest: { blocks: {} },
    schema: {
      definitions: {
        [btoa(DEPARTMENT_SHOP_RT)]: {
          allOf: [{ $ref: "#/definitions/DepartmentShopProps" }],
        },
        DepartmentShopProps: {
          title: TITLE_TPL,
          type: "object",
          properties: { kicker: { type: "string" }, title: { type: "string" } },
        },
        [btoa(PLAIN_RT)]: {
          title: "Hero",
          type: "object",
        },
      },
    },
  };
}

describe("resolveSectionTitleTemplate", () => {
  test("reads @title template from btoa(resolveType) Props schema via allOf", () => {
    expect(resolveSectionTitleTemplate(DEPARTMENT_SHOP_RT, meta())).toBe(
      TITLE_TPL,
    );
  });

  test("ignores a plain (non-template) title", () => {
    expect(resolveSectionTitleTemplate(PLAIN_RT, meta())).toBeUndefined();
  });

  test("returns undefined for an unknown resolveType", () => {
    expect(resolveSectionTitleTemplate("nope/x.tsx", meta())).toBeUndefined();
  });

  test("a template on the section's own definition wins over Props", () => {
    const rt = "site/sections/Own.tsx";
    const m: LiveMeta = {
      manifest: { blocks: {} },
      schema: {
        definitions: {
          [btoa(rt)]: {
            title: "Own {{a}}",
            allOf: [{ $ref: "#/definitions/OwnProps" }],
          },
          OwnProps: { title: "Props {{b}}" },
        },
      },
    };
    expect(resolveSectionTitleTemplate(rt, m)).toBe("Own {{a}}");
  });

  test("falls through a plain own title to a Props template", () => {
    const rt = "site/sections/Mixed.tsx";
    const m: LiveMeta = {
      manifest: { blocks: {} },
      schema: {
        definitions: {
          [btoa(rt)]: {
            title: "Plain Own Title",
            allOf: [{ $ref: "#/definitions/MixedProps" }],
          },
          MixedProps: { title: "Props {{b}}" },
        },
      },
    };
    expect(resolveSectionTitleTemplate(rt, m)).toBe("Props {{b}}");
  });

  test("reads schema from $defs when definitions is absent", () => {
    const rt = "site/sections/Defs.tsx";
    const m: LiveMeta = {
      manifest: { blocks: {} },
      schema: { $defs: { [btoa(rt)]: { title: "Defs {{a}}" } } },
    };
    expect(resolveSectionTitleTemplate(rt, m)).toBe("Defs {{a}}");
  });

  test("returns undefined when the schema has no definitions", () => {
    expect(
      resolveSectionTitleTemplate(DEPARTMENT_SHOP_RT, {
        manifest: { blocks: {} },
        schema: {},
      }),
    ).toBeUndefined();
  });
});

describe("getSectionDisplayTitle", () => {
  test("returns undefined without meta", () => {
    const raw = { __resolveType: DEPARTMENT_SHOP_RT, kicker: "Nike" };
    expect(getSectionDisplayTitle(raw, null)).toBeUndefined();
  });

  test("renders the template against the section props", () => {
    const raw = {
      __resolveType: DEPARTMENT_SHOP_RT,
      kicker: "Nike",
      title: "Up to 25% Off",
    };
    expect(getSectionDisplayTitle(raw, meta())).toBe(
      "Department Shop — Nike Up to 25% Off",
    );
  });

  test("collapses conditional blocks when props are absent", () => {
    const raw = { __resolveType: DEPARTMENT_SHOP_RT };
    expect(getSectionDisplayTitle(raw, meta())).toBe("Department Shop");
  });

  test("does not HTML-escape ampersands in the rendered title", () => {
    const raw = {
      __resolveType: DEPARTMENT_SHOP_RT,
      title: "Shoes & More",
    };
    expect(getSectionDisplayTitle(raw, meta())).toBe(
      "Department Shop   Shoes & More",
    );
  });

  test("unwraps a lazy-wrapped section before resolving the template", () => {
    const raw = {
      __resolveType: LAZY,
      section: {
        __resolveType: DEPARTMENT_SHOP_RT,
        kicker: "Nike",
      },
    };
    expect(getSectionDisplayTitle(raw, meta())).toBe("Department Shop  Nike");
  });

  test("unwraps a hidden (never-variant) section before resolving", () => {
    const raw = {
      __resolveType: MV,
      variants: [
        {
          value: { __resolveType: DEPARTMENT_SHOP_RT, kicker: "Nike" },
          rule: { __resolveType: NEVER },
        },
      ],
    };
    expect(getSectionDisplayTitle(raw, meta())).toBe("Department Shop  Nike");
  });

  test("falls back to undefined for a plain-titled section", () => {
    const raw = { __resolveType: PLAIN_RT };
    expect(getSectionDisplayTitle(raw, meta())).toBeUndefined();
  });

  test("collapses an object-valued prop to empty instead of [object Object]", () => {
    const rt = "site/sections/Obj.tsx";
    const m: LiveMeta = {
      manifest: { blocks: {} },
      schema: { definitions: { [btoa(rt)]: { title: "Banner {{img}}" } } },
    };
    const raw = {
      __resolveType: rt,
      img: { "@type": "ImageObject", url: "x" },
    };
    expect(getSectionDisplayTitle(raw, m)).toBe("Banner");
  });

  test("comma-joins a scalar array prop", () => {
    const rt = "site/sections/Tags.tsx";
    const m: LiveMeta = {
      manifest: { blocks: {} },
      schema: { definitions: { [btoa(rt)]: { title: "Tags {{tags}}" } } },
    };
    const raw = { __resolveType: rt, tags: ["a", "b"] };
    expect(getSectionDisplayTitle(raw, m)).toBe("Tags a,b");
  });

  test("returns undefined when the template renders to only whitespace", () => {
    const rt = "site/sections/Blank.tsx";
    const m: LiveMeta = {
      manifest: { blocks: {} },
      schema: { definitions: { [btoa(rt)]: { title: "{{#a}}{{a}}{{/a}}" } } },
    };
    expect(getSectionDisplayTitle({ __resolveType: rt }, m)).toBeUndefined();
  });

  test("returns undefined when the template is malformed (render throws)", () => {
    const rt = "site/sections/Bad.tsx";
    const m: LiveMeta = {
      manifest: { blocks: {} },
      schema: { definitions: { [btoa(rt)]: { title: "Bad {{#a}}unclosed" } } },
    };
    expect(getSectionDisplayTitle({ __resolveType: rt }, m)).toBeUndefined();
  });
});
