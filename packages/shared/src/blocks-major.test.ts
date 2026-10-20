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
 * Drops `//` and `/* *\/` comments, keeping strings and template literals (a
 * URL's `//` is not a comment). Good enough for a lint: regex literals are
 * read as code.
 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const body = text.slice(i, end === -1 ? text.length : end + 2);
      out += body.replace(/[^\n]/g, " ");
      i += body.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * v8 detection stays homogeneous: `isV8Schema` (this module) is the only
 * thing that reads a schema's `blocksMajor`, and nothing else decides v8.
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
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(entry.name)) {
        out.push(path);
      }
    }
    return out;
  }

  /** Tests and their fixtures: they may write a schema, never decide v8. */
  const isTestFile = (rel: string) =>
    /\.(test|spec|e2e)\.[cm]?[jt]sx?$/.test(rel) ||
    /(^|\/)(e2e|daemon-e2e|ct|fixtures|__tests__)\//.test(rel) ||
    /test-helpers?\.[jt]sx?$/.test(rel);

  const files = ["apps", "packages"]
    .flatMap((top) => sources(join(root, top)))
    .map((path) => {
      const rel = relative(root, path);
      return { rel, code: stripComments(readFileSync(path, "utf8")) };
    })
    .filter((f) => f.rel !== SELF && f.rel !== GUARD);
  const source = files.filter((f) => !isTestFile(f.rel));
  const tests = files.filter((f) => isTestFile(f.rel));

  /** `file:line` of every line of `list` that `pattern` matches. */
  function offending(
    list: typeof files,
    pattern: RegExp,
    allowed: (rel: string, line: string) => boolean = () => false,
  ): string[] {
    return list.flatMap((f) =>
      f.code
        .split("\n")
        .map((line, i) => ({ line, at: `${f.rel}:${i + 1}` }))
        .filter(({ line }) => pattern.test(line) && !allowed(f.rel, line))
        .map(({ at }) => at),
    );
  }

  const TOKEN = /\bblocksMajor\b/;

  test("the scan sees the code it guards", () => {
    const rels = new Set(files.map((f) => f.rel));
    expect(rels.has("apps/api/src/hosted/scope.ts")).toBe(true);
    expect(
      rels.has("apps/web/src/components/sections-editor/content-backend.ts"),
    ).toBe(true);
    // Plain JS too (scripts, the vite plugin), and the e2e fixtures.
    expect([...rels].some((rel) => /\.(m|c)?js$/.test(rel))).toBe(true);
    expect(rels.has("packages/e2e/fixtures/deco-serve-stub.ts")).toBe(true);
    expect(isTestFile("packages/e2e/fixtures/deco-serve-stub.ts")).toBe(true);
  });

  test("the comment stripper keeps code and strings", () => {
    expect(stripComments('a // blocksMajor\nb "//x" /* c\n d */ e')).toBe(
      `a \nb "//x" ${" ".repeat(4)}\n${" ".repeat(5)} e`,
    );
  });

  test("no source names blocksMajor outside @decocms/shared/blocks-major", () => {
    // Any non-comment use of the token: a read (`.blocksMajor`,
    // `?.["blocksMajor"]`, `"blocksMajor" in s`, `Reflect.get(s,
    // "blocksMajor")`), a destructuring, a write. Only these may name it:
    const allowed = (rel: string, line: string) =>
      // The marker's type on the project metadata the runtime reads.
      (rel === "packages/shared/src/thread/session-runtime.ts" &&
        /^\s*blocksMajor\?: number \| null;\s*$/.test(line)) ||
      // Copy telling a developer what their schema needs.
      (/^apps\/web\/src\/i18n\/(en|pt-br)\/deco-serve\.ts$/.test(rel) &&
        /"blocksMajor": 8/.test(line));
    expect(offending(source, TOKEN, allowed)).toEqual([]);
  });

  test("tests and fixtures only write blocksMajor, never read it", () => {
    // `blocksMajor: <value>` or `"blocksMajor": <value>` (an object literal
    // or schema JSON); anything else (`.blocksMajor`, `in`, a bare name, a
    // destructuring `{ blocksMajor: m } = s`) is a read.
    const write = /["']?\bblocksMajor\b["']?\s*:\s*/g;
    const destructure =
      /\{[^{}]*\bblocksMajor\b\s*:\s*[A-Za-z_$][\w$]*[^{}]*\}\s*=[^=>]/;
    const offenders = tests.flatMap((f) =>
      f.code
        .split("\n")
        .map((line, i) => ({ line, at: `${f.rel}:${i + 1}` }))
        .filter(
          ({ line }) =>
            TOKEN.test(line) &&
            (TOKEN.test(line.replace(write, "")) || destructure.test(line)),
        )
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });

  test("the rules catch the reads they ban", () => {
    const sample = (code: string) =>
      offending([{ rel: "x.ts", code: stripComments(code) }], TOKEN).length > 0;
    for (const read of [
      'm?.["blocksMajor"] === 8',
      "const { blocksMajor: m } = s;",
      '"blocksMajor" in s',
      'Reflect.get(s, "blocksMajor")',
      "s.blocksMajor === 8",
    ]) {
      expect(sample(read)).toBe(true);
    }
    expect(sample("// blocksMajor in a comment")).toBe(false);
    expect(sample(stripComments("/* blocksMajor */ x"))).toBe(false);
  });

  test("no other v8 predicate is defined", () => {
    const own =
      /(?:function|const|let|var|class)\s+(isV8Schema|isV8SchemaText|isBlocksV8Project|BLOCKS_V8_MAJOR|BLOCKS_MAJOR_METADATA_KEY|schemaGenPath)\b/;
    expect(offending(files, own)).toEqual([]);
  });

  test("every v8-named function is a known one built on isV8Schema", () => {
    // Each delegates to the shared predicate (or is UI, not a decision).
    // A new one must be added here, with a reason.
    const KNOWN: Record<string, string> = {
      "apps/api/src/hosted/scope.ts#mainIsV8": "isV8SchemaText on main",
      "apps/api/src/hosted/scope.ts#schemaBlobIsV8": "isV8SchemaText on a blob",
      "apps/api/src/hosted/blocks-major.ts#projectMainIsV8":
        "mainIsV8 (recent), written through to the marker",
      "apps/api/src/api/routes/decofile.ts#scopeIsV8": "projectMainIsV8",
      "apps/api/src/api/routes/decofile.ts#unownedV8": "scopeIsV8",
      "apps/web/src/hooks/use-main-schema-v8.ts#useMainSchemaV8":
        "fetchMainSchemaV8",
      "apps/web/src/hooks/use-main-schema-v8.ts#fetchMainSchemaV8":
        "isV8Schema on main's schema (rpc schema.get)",
      "apps/web/src/hooks/use-main-schema-v8.ts#useLastFoundV8":
        "the marker (the server's cached mainIsV8): a hint for a failed read, never v8",
      "apps/web/src/components/sections-editor/content-version-badge.tsx#showsV8Badge":
        "UI: reads the backend the probe chose",
      "apps/web/src/components/thread/repository/localhost-row.tsx#V8LocalhostRow":
        "UI component",
    };
    const definition =
      /(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*[vV]8[\w$]*)\s*(?:[=(<]|:\s*\(|:\s*[A-Z][\w$<>, |]*\s*=\s*(?:async\s*)?\()/g;
    const found = source.flatMap((f) =>
      [...f.code.matchAll(definition)]
        .filter(([text]) => /function|\(|=>/.test(text) || /=\s*\(/.test(text))
        .map(([, name]) => `${f.rel}#${name}`),
    );
    const isFunction = (key: string) => {
      const [rel, name] = key.split("#");
      const code = source.find((f) => f.rel === rel)!.code;
      return new RegExp(
        `(?:function\\*?\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[\\w$]+)\\s*(?::[^=]+)?=>)`,
      ).test(code!);
    };
    const functions = found.filter(isFunction);
    // The scan finds them (so a new one can't slip by unnoticed)...
    expect(functions).toContain("apps/api/src/hosted/scope.ts#mainIsV8");
    expect(functions).toContain(
      "apps/api/src/api/routes/decofile.ts#scopeIsV8",
    );
    // ...and every one is known.
    expect(functions.filter((key) => !KNOWN[key])).toEqual([]);
  });

  test("no old v8 heuristic decides anything", () => {
    const banned: Array<[string, RegExp]> = [
      // A version or major compared with 8 (the field, a package version).
      [
        "major/version vs 8",
        /(major|version)\w*["'\]]?\s*(?:[!=]==?|>=?)\s*["']?8\b/i,
      ],
      ["8 vs major/version", /\b8\s*(?:[!=]==?|<=?)\s*[\w.?]*(major|version)/i],
      // `@decocms/blocks`'s version from a package.json.
      ["@decocms/blocks version", /\[\s*["']@decocms\/blocks["']\s*\]/],
      // `deco serve`'s describe fields as a v8 test.
      [
        "describe version/protocol",
        /\bdescribe\??\.(?:version|major|protocol)\b/,
      ],
    ];
    const offenders = banned.flatMap(([name, pattern]) =>
      offending(source, pattern).map((at) => `${name}: ${at}`),
    );
    expect(offenders).toEqual([]);
  });

  test("v8 is never decided from meta.gen.json", () => {
    // `meta.gen.json` is v7's schema. The files that decide v8 never consult
    // it; elsewhere (v7 code still reads it) no line ties it to v8.
    const DECIDERS = [
      "apps/api/src/hosted/scope.ts",
      "apps/api/src/hosted/blocks-major.ts",
      "apps/web/src/components/sections-editor/content-backend.ts",
      "apps/web/src/components/sections-editor/use-content-backend.ts",
      "apps/web/src/hooks/use-main-schema-v8.ts",
      "apps/web/src/hooks/use-deco-serve-connection.ts",
    ];
    const deciders = source.filter((f) => DECIDERS.includes(f.rel));
    expect(deciders.map((f) => f.rel).sort()).toEqual([...DECIDERS].sort());
    expect([
      ...offending(deciders, /meta\.gen\.json/),
      ...offending(
        source,
        /meta\.gen\.json.*\b(is)?v8|\b(is)?v8\w*\b.*meta\.gen\.json/i,
      ),
    ]).toEqual([]);
  });

  test("the web app never decides v8 from the marker", () => {
    // The marker is the server's cache of main's answer. The web app reads
    // main's schema itself (`useMainSchemaV8`), which only compares it
    // with the marker it holds to re-read a project the server just rewrote,
    // and to tell a failed read on a site last found v8 (waits) from any
    // other (v7, as on main): `useLastFoundV8`, never a v8 answer.
    const allowed = (rel: string) =>
      rel === "apps/web/src/hooks/use-main-schema-v8.ts";
    expect(
      offending(
        source.filter((f) => f.rel.startsWith("apps/web/")),
        /\b(isBlocksV8Project|BLOCKS_MAJOR_METADATA_KEY)\b/,
        (rel) => allowed(rel),
      ),
    ).toEqual([]);
  });

  test("no org flag gates v8", () => {
    const flag = ["site", "editor", "content", "protocol"].join("_");
    const all = ["apps", "packages"].flatMap((top) =>
      sources(join(root, top)).map((path) => ({
        rel: relative(root, path),
        text: readFileSync(path, "utf8"),
      })),
    );
    const offenders = all
      .filter((f) => f.rel !== GUARD && f.text.includes(flag))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
