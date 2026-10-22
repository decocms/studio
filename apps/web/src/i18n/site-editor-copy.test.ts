/**
 * The site editor speaks to business users: its copy never names the
 * machinery behind a save or a publish. A publish toast says the site will
 * show it shortly, never "live"; the Releases screen says "release", never
 * "version", except its two actions on an earlier release: "Preview this
 * version" and "Make current" (the words the experiments design uses), and
 * "Make current" is that action's one name everywhere.
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
 * The only strings allowed to say "version", "current" or "atual": "Preview
 * this version", and "Make current" (pt-br "Tornar atual"), the name of the
 * action on an earlier release, wherever that action is spoken of: the menu
 * item, the confirm dialog, its progress, success and failure toasts, the
 * undo hints and the note on the release it makes. Exactly these strings on
 * exactly these keys; they are still checked for every other banned word.
 * "Current" stays banned in every other string, since a sentence about what
 * is "current" reads as what visitors see right now, which the site's cache
 * decides, not Studio.
 */
const EXACT_EXCEPTIONS: Record<"en" | "pt-br", Record<string, string>> = {
  en: {
    "releases.preview": "Preview this version",
    "releases.reapply": "Make current",
    "releases.reapplyConfirm": "Make current",
    "releases.subtitle":
      "Every release of your site, newest first. Make an earlier one current to bring its content back.",
    "releases.reapplyTitle": "Make this release current?",
    "releases.reapplyBody":
      "Making it current publishes a new release with the same content as “{title}”. Changes made since will be replaced on your site.",
    "releases.reapplyUndoHint":
      "The release marked Latest stays in the list: to go back afterwards, make it current again.",
    "releases.reapplying": "Making current…",
    "releases.reapplied": "Made current. Your site will show it shortly.",
    "releases.reappliedUndoHint":
      "If something doesn't look right, make the previous release current again to go back.",
    "releases.reapplyFailed": "Couldn't make this release current.",
    "releases.publishedMeanwhile":
      "Someone published while you were making this release current, so nothing changed. Try again.",
    "releases.reapplyOf": "Made current: {title}",
    "releases.reapplyOfDate": "Made current: release from {when}",
  },
  "pt-br": {
    "releases.preview": "Visualizar esta versão",
    "releases.reapply": "Tornar atual",
    "releases.reapplyConfirm": "Tornar atual",
    "releases.subtitle":
      "Todas as releases do seu site, da mais recente para a mais antiga. Para trazer de volta o conteúdo de uma anterior, torne-a atual.",
    "releases.reapplyTitle": "Tornar esta release atual?",
    "releases.reapplyBody":
      "Ao torná-la atual, publicamos uma nova release com o mesmo conteúdo de “{title}”. As alterações feitas desde então serão substituídas no seu site.",
    "releases.reapplyUndoHint":
      "A release marcada como Mais recente continua na lista: para voltar depois, torne-a atual de novo.",
    "releases.reapplying": "Tornando atual…",
    "releases.reapplied":
      "Release tornada atual. Seu site vai mostrá-la em instantes.",
    "releases.reappliedUndoHint":
      "Se algo não ficar certo, torne atual de novo a release anterior para voltar.",
    "releases.reapplyFailed": "Não foi possível tornar esta release atual.",
    "releases.publishedMeanwhile":
      "Alguém publicou enquanto você tornava esta release atual, então nada mudou. Tente de novo.",
    "releases.reapplyOf": "Tornada atual: {title}",
    "releases.reapplyOfDate": "Tornada atual: release de {when}",
  },
};

/** The words an exception may say; it is still checked for all the others. */
const EXCEPTION_WORDS = new Set(
  [/\bcurrent\b/i, /\batual\b/i, /version/i, /vers[ãa]o/i].map(String),
);

const isException = (
  lang: "en" | "pt-br",
  key: string,
  value: string,
  banned: RegExp,
) =>
  EXACT_EXCEPTIONS[lang][key] === value && EXCEPTION_WORDS.has(String(banned));

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
        for (const banned of BANNED) {
          if (isException(name, key, value, banned)) continue;
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
        for (const banned of RELEASES_BANNED) {
          if (isException(name, key, value, banned)) continue;
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

  test("only the exceptions say current, atual (or, in Releases, version)", () => {
    const anywhere = [/\bcurrent\b/i, /\batual\b/i];
    const inReleases = [/version/i, /vers[ãa]o/i];
    for (const [lang, dict] of [
      ["en", en],
      ["pt-br", ptBR],
    ] as const) {
      const saying = siteEditorEntries(dict as Record<string, string>)
        .filter(
          ([key, value]) =>
            anywhere.some((w) => w.test(value)) ||
            (key.startsWith("releases.") &&
              inReleases.some((w) => w.test(value))),
        )
        .map(([key]) => key)
        .sort();
      expect(saying).toEqual(Object.keys(EXACT_EXCEPTIONS[lang]).sort());
    }
  });

  test("an exception is still checked for every other banned word", () => {
    expect(
      isException("en", "releases.reapply", "Make current", /\bcommit/i),
    ).toBe(false);
    expect(
      isException("en", "releases.reapply", "Make current", /\bcurrent\b/i),
    ).toBe(true);
    expect(
      isException("en", "releases.title", "Make current", /\bcurrent\b/i),
    ).toBe(false);
  });

  test("Releases call the action Make current everywhere", () => {
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
    expect(en["releases.reapplyTitle"]).toBe("Make this release current?");
    expect(ptBR["releases.reapplyTitle"]).toBe("Tornar esta release atual?");
    expect(en["releases.reapplied"]).toBe(
      "Made current. Your site will show it shortly.",
    );
    expect(en["releases.reapplyFailed"]).toBe(
      "Couldn't make this release current.",
    );
    expect(en["releases.reapplyOf"]).toBe("Made current: {title}");
    expect(ptBR["releases.reapplyOf"]).toBe("Tornada atual: {title}");
    // No string in Releases says "reapply" any more.
    for (const dict of [en, ptBR]) {
      for (const [key, value] of Object.entries(
        dict as Record<string, string>,
      )) {
        if (!key.startsWith("releases.")) continue;
        expect(value).not.toMatch(/reappl|reaplic/i);
      }
    }
  });
});

describe("the publish panel's button (PO decision)", () => {
  test('v7 keeps main\'s "in production" labels', () => {
    expect(en["thread.publishPopover.publishCountInProduction"]).toBe(
      "Publish {count} changes in production",
    );
    expect(en["thread.publishPopover.publishOneInProduction"]).toBe(
      "Publish 1 change in production",
    );
    expect(ptBR["thread.publishPopover.publishCountInProduction"]).toBe(
      "Publicar {count} alterações em produção",
    );
    expect(ptBR["thread.publishPopover.publishOneInProduction"]).toBe(
      "Publicar 1 alteração em produção",
    );
  });

  test('v8 says "Publish N changes", never where they go', () => {
    expect(en["thread.publishPopover.publishCount"]).toBe(
      "Publish {count} changes",
    );
    expect(en["thread.publishPopover.publishOne"]).toBe("Publish 1 change");
    expect(ptBR["thread.publishPopover.publishCount"]).toBe(
      "Publicar {count} alterações",
    );
    expect(ptBR["thread.publishPopover.publishOne"]).toBe(
      "Publicar 1 alteração",
    );
    for (const dict of [en, ptBR]) {
      for (const [key, value] of Object.entries(
        dict as Record<string, string>,
      )) {
        if (!key.startsWith("thread.publishPopover.")) continue;
        // v7's own labels (publish-title.ts picks them only off v8).
        if (key.endsWith("InProduction")) continue;
        expect(value).not.toMatch(/in production|em produção/i);
      }
    }
  });
});
