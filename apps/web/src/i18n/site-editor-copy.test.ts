/**
 * The site editor speaks to business users: its copy never names the
 * machinery behind a save or a publish. "Published" means live.
 */

import { describe, expect, test } from "bun:test";
import { en } from "./en/index.ts";
import { ptBR } from "./pt-br/index.ts";

/** Namespaces whose every string a business user reads in the site editor. */
const SITE_EDITOR_PREFIXES = ["siteEditor."];

const BANNED: RegExp[] = [
  /\bCDN\b/i,
  /\bmerge[ds]?\b/i,
  /mesclad/i,
  /\bcommit/i,
  /\bgit\b/i,
  /\bbranch/i,
  /\bpointer\b/i,
  /latest\.json/i,
  /\brevision/i,
  /\bsha\b/i,
  /make current/i,
  /tornar atual/i,
];

const siteEditorEntries = (dict: Record<string, string>) =>
  Object.entries(dict).filter(([key]) =>
    SITE_EDITOR_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );

describe("site editor copy", () => {
  for (const [name, dict] of [
    ["en", en],
    ["pt-br", ptBR],
  ] as const) {
    test(`${name}: no developer jargon`, () => {
      const entries = siteEditorEntries(dict as Record<string, string>);
      expect(entries.length).toBeGreaterThan(0);
      for (const [key, value] of entries) {
        for (const banned of BANNED) {
          if (banned.test(value)) {
            throw new Error(`${key} says ${banned}: "${value}"`);
          }
        }
      }
    });
  }
});
