import { describe, expect, it } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";

/** The sentence that says how to bring a deleted block back. */
const UNDO = {
  en: "To bring it back, discard its deletion in Publish.",
  ptBR: "Para trazer de volta, descarte a exclusão em Publicar.",
};

describe("leaving a block deleted says one way to undo it", () => {
  it("the toast and the deleted panel give the same way", () => {
    for (const [dict, sentence] of [
      [en, UNDO.en],
      [ptBR, UNDO.ptBR],
    ] as const) {
      expect(dict["sectionsEditor.reconcile.leftDeletedHint"]).toContain(
        sentence,
      );
      expect(dict["sectionsEditor.reconcile.deletedDescription"]).toContain(
        sentence,
      );
      // Never "make it again any time" for a deletion it kept.
      expect(dict["sectionsEditor.reconcile.leftDeletedHint"]).not.toContain(
        dict["sectionsEditor.reconcile.keptTheirsHint"],
      );
    }
  });

  it("a block that was never published is never told to come back through Publish", () => {
    for (const [dict, sentence] of [
      [en, UNDO.en],
      [ptBR, UNDO.ptBR],
    ] as const) {
      for (const key of [
        "sectionsEditor.reconcile.leftDeletedNeverPublishedHint",
        "sectionsEditor.reconcile.deletedNeverPublishedDescription",
      ] as const) {
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toContain(sentence);
      }
    }
  });
});
