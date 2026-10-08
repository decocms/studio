import { describe, expect, it } from "bun:test";
import { ContentProtocolError, ErrorCode } from "@decocms/blocks/protocol";
import {
  groupBlocksByType,
  isNoSchemaMeta,
  isSchemaAbsent,
  noSchemaMeta,
  parseNumberInput,
  setAtPath,
  typeLabel,
} from "./schemaless";

describe("isSchemaAbsent", () => {
  it("reads schema: null and an older server's NotFound as no schema", () => {
    expect(
      isSchemaAbsent({
        ok: true,
        result: {
          notModified: false,
          version: null,
          resolvedRef: null,
          schema: null,
        },
      }),
    ).toBe(true);
    expect(
      isSchemaAbsent({
        ok: false,
        error: new ContentProtocolError(ErrorCode.NotFound, "no schema"),
      }),
    ).toBe(true);
  });

  it("is false for a schema, a 'not modified' and any other error", () => {
    expect(
      isSchemaAbsent({
        ok: true,
        result: {
          notModified: false,
          version: "v1",
          resolvedRef: null,
          schema: {},
        },
      }),
    ).toBe(false);
    expect(
      isSchemaAbsent({
        ok: true,
        result: { notModified: true, version: "v1" },
      }),
    ).toBe(false);
    expect(
      isSchemaAbsent({
        ok: false,
        error: new ContentProtocolError(ErrorCode.Unavailable, "busy"),
      }),
    ).toBe(false);
  });
});

describe("noSchemaMeta", () => {
  it("is an empty schema the editor can tell apart", () => {
    const meta = noSchemaMeta();
    expect(meta.manifest.blocks).toEqual({});
    expect(isNoSchemaMeta(meta)).toBe(true);
    expect(isNoSchemaMeta({ manifest: { blocks: {} }, schema: {} })).toBe(
      false,
    );
    expect(isNoSchemaMeta(undefined)).toBe(false);
  });
});

describe("groupBlocksByType", () => {
  it("groups every block by __resolveType, sorted by name, untyped last", () => {
    const groups = groupBlocksByType({
      "pages-home": { __resolveType: "website/pages/Page.tsx", name: "Home" },
      "pages-about": { __resolveType: "website/pages/Page.tsx", name: "About" },
      Header: { __resolveType: "site/sections/Header.tsx" },
      loose: { title: "no type" },
    });
    expect(groups).toEqual([
      {
        resolveType: "site/sections/Header.tsx",
        blocks: [{ key: "Header", label: "Header" }],
      },
      {
        resolveType: "website/pages/Page.tsx",
        blocks: [
          { key: "pages-about", label: "About" },
          { key: "pages-home", label: "Home" },
        ],
      },
      { resolveType: null, blocks: [{ key: "loose", label: "loose" }] },
    ]);
  });

  it("names a type by its last path segment", () => {
    expect(typeLabel("site/sections/Header.tsx")).toBe("Header");
    expect(typeLabel("website/loaders/redirects.ts")).toBe("redirects");
  });
});

describe("setAtPath", () => {
  it("replaces one leaf and keeps every other value and the key order", () => {
    const block = {
      __resolveType: "site/sections/Hero.tsx",
      title: "Hi",
      items: [
        { n: 1, on: true },
        { n: 2, on: false },
      ],
      nested: { a: null, b: "x" },
    };
    const next = setAtPath(block, ["items", 1, "n"], 3);
    expect(JSON.stringify(next)).toBe(
      JSON.stringify({
        ...block,
        items: [
          { n: 1, on: true },
          { n: 3, on: false },
        ],
      }),
    );
    // The original is untouched.
    expect(block.items[1]!.n).toBe(2);
  });
});

describe("parseNumberInput", () => {
  it("reads finite numbers only", () => {
    expect(parseNumberInput("42")).toBe(42);
    expect(parseNumberInput("-1.5")).toBe(-1.5);
    expect(parseNumberInput("")).toBeNull();
    expect(parseNumberInput("4a")).toBeNull();
  });
});
