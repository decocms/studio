import { describe, expect, it } from "bun:test";
import { PLAN_OBJECTIVE_MAX_LENGTH } from "@decocms/shared/organization/schema";
import { en } from "@/i18n/en/index.ts";
import { interpolate } from "@/i18n/interpolate.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";

describe("plan.prompt.suggestObjective", () => {
  for (const [locale, dictionary] of [
    ["en", en],
    ["pt-BR", ptBR],
  ] as const) {
    it(`${locale}: names the writer tool and the goal's length cap`, () => {
      const text = interpolate(dictionary["plan.prompt.suggestObjective"], {
        max: PLAN_OBJECTIVE_MAX_LENGTH,
      });
      expect(text).toContain("ORGANIZATION_PLAN_OBJECTIVE_SET");
      expect(text).toContain(String(PLAN_OBJECTIVE_MAX_LENGTH));
      expect(text).not.toContain("{max}");
    });
  }
});
