import { describe, expect, it } from "bun:test";
import { en } from "./en/index.ts";
import { ptBR } from "./pt-br/index.ts";

function placeholders(value: string): Set<string> {
  return new Set(value.match(/\{[a-zA-Z]+\}/g) ?? []);
}

describe("placeholder parity", () => {
  // A pt-br value may legitimately drop a placeholder (e.g. an English-only
  // plural suffix like {plural} in "connection{plural}"), but must never
  // reference one its en counterpart doesn't have — callers interpolate the
  // en placeholder set, so anything extra renders as literal "{foo}".
  it("pt-br values only use placeholders that exist in their en value", () => {
    for (const [key, enValue] of Object.entries(en)) {
      const enSet = placeholders(enValue);
      const extra = [...placeholders(ptBR[key as keyof typeof ptBR])].filter(
        (p) => !enSet.has(p),
      );
      expect(extra, key).toEqual([]);
    }
  });
});
