import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `@monaco-editor/react` loads the engine from a CDN unless told otherwise,
 * and whichever component mounts first latches that choice for the page. The
 * packaged desktop app cannot load a CDN script at all (`script-src 'self'`),
 * so a component importing the library directly renders a permanent spinner
 * there while every other signal stays green — which is exactly how this
 * shipped. `components/monaco/` owns the configuration; everyone else imports
 * `Editor`/`DiffEditor` from `components/monaco/editor.ts`.
 */
const SANCTIONED_DIR = join(import.meta.dir);
const WEB_SRC = join(import.meta.dir, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("monaco imports", () => {
  test("only components/monaco reaches @monaco-editor/react", () => {
    const offenders = sourceFiles(WEB_SRC)
      .filter((path) => !path.startsWith(SANCTIONED_DIR))
      .filter((path) =>
        /from "@monaco-editor\/react"/.test(readFileSync(path, "utf8")),
      )
      .map((path) => path.slice(WEB_SRC.length + 1));

    expect(offenders).toEqual([]);
  });
});
