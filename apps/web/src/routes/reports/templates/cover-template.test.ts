import { describe, expect, test } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import { AREA_LABEL } from "./cover-template.tsx";

/**
 * The engine keys `scores.categories` by macro-theme. An unmapped key falls back
 * to the engine's own `label`, which is baked in Portuguese at generation time
 * whatever `lang` the reader asked for — so a missing entry here is silently an
 * untranslated cover, not a crash. Both key generations are pinned because the
 * deployed engine still serves the pre-#255 set while `main` serves the new one.
 */
const MACROTEMAS = [
  "funil",
  "tecnica",
  "tagging",
  "aquisicao",
  "retencao",
  "catalogo",
];

// commerce-skills before #255 ("reorganize report score areas into 5 business
// macrotemas"), still live and still present in cached reports.
const LEGACY_AREAS = [
  "seo",
  "geo",
  "performance",
  "accessibility",
  "security",
  "ux",
  "tracking",
  "infra",
  "retention",
];

describe("AREA_LABEL", () => {
  test.each(MACROTEMAS)("maps the %s macro theme", (key) => {
    expect(AREA_LABEL[key]).toBeDefined();
  });

  test.each(LEGACY_AREAS)("still maps the legacy %s area", (key) => {
    expect(AREA_LABEL[key]).toBeDefined();
  });

  test("every mapped key resolves in both dictionaries", () => {
    for (const translationKey of Object.values(AREA_LABEL)) {
      expect(en[translationKey]).toBeTruthy();
      expect(ptBR[translationKey]).toBeTruthy();
    }
  });

  test("labels stay short enough for the two-column grid", () => {
    // The rows sit beside a ring and a coverage count; past ~22 characters the
    // label truncates mid-word at 1440px.
    for (const translationKey of Object.values(AREA_LABEL)) {
      expect(en[translationKey].length).toBeLessThanOrEqual(22);
      expect(ptBR[translationKey].length).toBeLessThanOrEqual(22);
    }
  });
});
