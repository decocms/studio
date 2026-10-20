/**
 * Reads `.oxlintrc.json` for the plugin tests.
 *
 * The config carries comments — every `"off"` rule has to say why it is off
 * (see "Lint severity" in AGENTS.md), and oxlint's parser accepts them. Node's
 * `JSON.parse` does not, so strip them here rather than in each test.
 */
import { readFileSync } from "node:fs";

export interface OxlintConfig {
  jsPlugins: string[];
  rules: Record<string, unknown>;
}

/** Strips `//` line comments that are not inside a string literal. */
function stripComments(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += source[++i] ?? "";
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

export function readOxlintConfig(root: string): OxlintConfig {
  return JSON.parse(
    stripComments(readFileSync(`${root}/.oxlintrc.json`, "utf8")),
  ) as OxlintConfig;
}
