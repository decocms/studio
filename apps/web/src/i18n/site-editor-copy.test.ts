/**
 * The site editor speaks to business users: its copy never names the
 * machinery behind a save or a publish. A publish toast says the site will
 * show it shortly, never "live"; the Releases screen says "release", never
 * "version", except its two actions on an earlier release: "Preview this
 * version" and "Make current" (the words the experiments design uses).
 */

import { describe, expect, test } from "bun:test";
import { en } from "./en/index.ts";
import { ptBR } from "./pt-br/index.ts";

/** Namespaces whose every string a business user reads in the site editor. */
const SITE_EDITOR_PREFIXES = [
  "siteEditor.",
  "releases.",
  "common.mainPanelTabs.releases",
  "projects.apps.releases",
  "thread.publishPopover.",
];

const BANNED: RegExp[] = [
  /\bCDN\b/i,
  /\bmerge[ds]?\b/i,
  /mescl/i,
  /\brebase/i,
  /\bcommit/i,
  /\bgit\b/i,
  /\bbranch/i,
  /\bpointer\b/i,
  /latest\.json/i,
  /\brevision/i,
  /\bsha\b/i,
  /\bcurrent\b/i,
  /\batual\b/i,
  /\brevert/i,
  /revers/i,
];

/**
 * The Releases screen says "Latest" for the newest release, never what a
 * visitor sees right now; it says "release", never "version"; and it stays
 * calm (it says how to go back, it doesn't warn twice).
 */
const RELEASES_BANNED: RegExp[] = [
  /\blive\b/i,
  /version/i,
  /vers[ãa]o/i,
  /vers[õo]es/i,
  /\bno ar\b/i,
  /republi/i,
  /\banyway\b/i,
  /mesmo assim/i,
];

/**
 * The only strings allowed to say "version" or "current": the two actions on
 * an earlier release (and the confirm button of the second), exactly these
 * words. "Current" is still banned in every other string, since a sentence
 * about what is "current" reads as what visitors see right now, which the
 * site's cache decides, not Studio.
 */
const EXACT_EXCEPTIONS: Record<"en" | "pt-br", Record<string, string>> = {
  en: {
    "releases.preview": "Preview this version",
    "releases.reapply": "Make current",
    "releases.reapplyConfirm": "Make current",
  },
  "pt-br": {
    "releases.preview": "Visualizar esta versão",
    "releases.reapply": "Tornar atual",
    "releases.reapplyConfirm": "Tornar atual",
  },
};

const isException = (lang: "en" | "pt-br", key: string, value: string) =>
  EXACT_EXCEPTIONS[lang][key] === value;

/** Publish toasts: "Published. Your site will show it shortly." Never "live". */
const PUBLISH_TOAST_PREFIX = "siteEditor.publish.";
const PUBLISH_TOAST_BANNED: RegExp[] = [/live/i, /no ar\b/i];

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
        if (isException(name, key, value)) continue;
        for (const banned of BANNED) {
          if (banned.test(value)) {
            throw new Error(`${key} says ${banned}: "${value}"`);
          }
        }
      }
    });
  }

  for (const [name, dict] of [
    ["en", en],
    ["pt-br", ptBR],
  ] as const) {
    test(`${name}: Releases say Latest and release, calmly`, () => {
      const entries = Object.entries(dict as Record<string, string>).filter(
        ([key]) => key.startsWith("releases."),
      );
      expect(entries.length).toBeGreaterThan(0);
      for (const [key, value] of entries) {
        if (isException(name, key, value)) continue;
        for (const banned of RELEASES_BANNED) {
          if (banned.test(value)) {
            throw new Error(`${key} says ${banned}: "${value}"`);
          }
        }
      }
    });
  }

  for (const [name, dict] of [
    ["en", en],
    ["pt-br", ptBR],
  ] as const) {
    test(`${name}: publish toasts say the site will show it shortly, never live`, () => {
      const entries = Object.entries(dict as Record<string, string>).filter(
        ([key]) => key.startsWith(PUBLISH_TOAST_PREFIX),
      );
      expect(entries.length).toBeGreaterThan(0);
      for (const [key, value] of entries) {
        for (const banned of PUBLISH_TOAST_BANNED) {
          if (banned.test(value)) {
            throw new Error(`${key} says ${banned}: "${value}"`);
          }
        }
      }
    });
  }

  test("the exceptions are exactly the Releases action words", () => {
    for (const [lang, dict] of [
      ["en", en],
      ["pt-br", ptBR],
    ] as const) {
      for (const [key, value] of Object.entries(EXACT_EXCEPTIONS[lang])) {
        expect((dict as Record<string, string>)[key]).toBe(value);
      }
    }
  });

  test("the exact Published and Reapply words", () => {
    expect(en["siteEditor.publish.published"]).toBe(
      "Published. Your site will show it shortly.",
    );
    expect(ptBR["siteEditor.publish.published"]).toBe(
      "Publicado. Seu site vai mostrar em instantes.",
    );
    expect(en["releases.preview"]).toBe("Preview this version");
    expect(ptBR["releases.preview"]).toBe("Visualizar esta versão");
    expect(en["releases.reapply"]).toBe("Make current");
    expect(ptBR["releases.reapply"]).toBe("Tornar atual");
    expect(en["releases.reapplyTitle"]).toBe("Reapply this release?");
    expect(ptBR["releases.reapplyTitle"]).toBe("Reaplicar esta release?");
    expect(en["releases.reapplied"]).toBe(
      "Reapplied. Your site will show it shortly.",
    );
    expect(en["releases.reapplyFailed"]).toBe("Couldn't reapply this release.");
  });
});
