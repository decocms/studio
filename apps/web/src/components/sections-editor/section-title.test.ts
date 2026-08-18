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
});
