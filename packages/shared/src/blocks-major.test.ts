import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  isBlocksV8Project,
  isV8Schema,
  isV8SchemaText,
  schemaGenPath,
} from "./blocks-major.ts";

describe("isV8Schema", () => {
  test('only a top-level "blocksMajor": 8 is v8', () => {
    expect(isV8Schema({ blocksMajor: 8 })).toBe(true);
    expect(isV8Schema({ blocksMajor: 8, definitions: {}, root: {} })).toBe(
      true,
    );
  });

  test("anything else is v7", () => {
    for (const schema of [
      {},
      { blocksMajor: 7 },
      { blocksMajor: 9 },
      { blocksMajor: "8" },
      { blocksMajor: null },
      { root: { blocksMajor: 8 } },
      Object.assign([], { blocksMajor: 8 }),
      null,
      undefined,
      8,
      "8",
    ]) {
      expect(isV8Schema(schema)).toBe(false);
    }
  });

  test("text: parsed first; unparseable or missing text is v7", () => {
    expect(isV8SchemaText('{"blocksMajor":8}')).toBe(true);
    expect(isV8SchemaText('{"blocksMajor":7}')).toBe(false);
    expect(isV8SchemaText("[]")).toBe(false);
    expect(isV8SchemaText("{")).toBe(false);
    expect(isV8SchemaText("")).toBe(false);
    expect(isV8SchemaText(null)).toBe(false);
    expect(isV8SchemaText(undefined)).toBe(false);
  });

  test("the schema file, at the repo root or under the site's folder", () => {
    expect(schemaGenPath(null)).toBe(".deco/schema.gen.json");
    expect(schemaGenPath("apps/site")).toBe("apps/site/.deco/schema.gen.json");
  });
});

describe("isBlocksV8Project (the cached answer for main)", () => {
  test("only the server's marker 8 counts", () => {
    expect(isBlocksV8Project({ blocksMajor: 8 })).toBe(true);
    expect(isBlocksV8Project({ blocksMajor: "8" })).toBe(false);
    expect(isBlocksV8Project({ blocksMajor: 7 })).toBe(false);
    expect(isBlocksV8Project({})).toBe(false);
    expect(isBlocksV8Project(null)).toBe(false);
    expect(isBlocksV8Project(undefined)).toBe(false);
  });
});

/**
 * v8 detection stays homogeneous: this module is the only place that reads a
 * schema's `blocksMajor`, and no org flag decides v8.
 */
describe("one v8 detector", () => {
  const root = join(import.meta.dir, "../../..");
  const SELF = "packages/shared/src/blocks-major.ts";
  const GUARD = "packages/shared/src/blocks-major.test.ts";
  const SKIP_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    ".turbo",
    "test-results",
    "playwright-report",
  ]);

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sources(path));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
    }
    return out;
  }

  const files = ["apps", "packages"].flatMap((top) =>
    sources(join(root, top)).map((path) => ({
      rel: relative(root, path),
      text: readFileSync(path, "utf8"),
    })),
  );

  test("the scan sees the code it guards", () => {
    const rels = new Set(files.map((f) => f.rel));
    expect(rels.has(SELF)).toBe(true);
    expect(rels.has("apps/api/src/hosted/scope.ts")).toBe(true);
    expect(
      rels.has("apps/web/src/components/sections-editor/content-backend.ts"),
    ).toBe(true);
  });

  test("no code reads blocksMajor outside @decocms/shared/blocks-major", () => {
    // A read or comparison of the field: `.blocksMajor`, `blocksMajor ===`,
    // `["blocksMajor"]`. Fixtures that write `blocksMajor: 8` are fine.
    const read =
      /\.blocksMajor\b|\bblocksMajor\s*[!=]==?|[\w)\]]\s*\[\s*["']blocksMajor["']\s*\]/;
    const offenders = files
      .filter((f) => f.rel !== SELF && f.rel !== GUARD)
      .flatMap((f) =>
        f.text
          .split("\n")
          .map((line, i) => ({ line, at: `${f.rel}:${i + 1}` }))
          .filter(({ line }) => {
            const code = line.replace(/\/\/.*$/, "").trim();
            return !code.startsWith("*") && read.test(code);
          })
          .map(({ at }) => at),
      );
    expect(offenders).toEqual([]);
  });

  test("no other v8 predicate is defined", () => {
    const own =
      /(?:function|const|let)\s+(isV8Schema|isV8SchemaText|isBlocksV8Project|V8_BLOCKS_MAJOR|BLOCKS_V8_MAJOR|BLOCKS_MAJOR_METADATA_KEY)\b/;
    const offenders = files
      .filter((f) => f.rel !== SELF && f.rel !== GUARD && own.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("no org flag gates v8", () => {
    const flag = ["site", "editor", "content", "protocol"].join("_");
    const offenders = files
      .filter((f) => f.text.includes(flag))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
