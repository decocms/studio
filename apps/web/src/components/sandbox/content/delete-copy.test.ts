import { describe, expect, it } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import { deleteConfirmKey } from "./delete-copy";

describe("delete confirmations", () => {
  it("a hosted v8 draft's delete is a draft change: never 'permanent', and says how to undo it", () => {
    for (const what of ["block", "post", "section"] as const) {
      const key = deleteConfirmKey(what, true);
      for (const copy of [en[key], ptBR[key]]) {
        expect(copy).not.toMatch(
          /permanent|can't be undone|não pode ser desfeito/i,
        );
        expect(copy).toMatch(/Publish|Publicar/);
        expect(copy).toMatch(/\{(label|title)\}/);
      }
    }
  });

  it("every other site keeps its copy", () => {
    expect(deleteConfirmKey("block", false)).toBe(
      "sandbox.contentBrowser.deleteDialog.descriptionPermanent",
    );
    expect(deleteConfirmKey("post", false)).toBe(
      "sandbox.postEditor.deletePostConfirmBody",
    );
    expect(deleteConfirmKey("section", false)).toBe(
      "sandbox.contentBrowser.deleteDialog.descriptionSection",
    );
  });

  it("a hosted global section's delete says it's a draft change, worded like a page's, and what it does to pages", () => {
    const key = deleteConfirmKey("section", true);
    expect(en[key]).toContain("Nothing goes live until you publish");
    expect(en[key]).toContain(
      "you can bring it back by discarding this change in Publish",
    );
    expect(en[key]).toContain("lose this section");
    expect(ptBR[key]).toContain("descartando esta alteração em Publicar");
  });

  it("a hosted delete of what was never published promises no way back through Publish (Publish never lists it)", () => {
    for (const what of ["block", "post", "section"] as const) {
      const key = deleteConfirmKey(what, true, { neverPublished: true });
      expect(key).not.toBe(deleteConfirmKey(what, true));
      for (const copy of [en[key], ptBR[key]]) {
        expect(copy).not.toMatch(/discard|descartando/i);
        expect(copy).toMatch(/never published|nunca foi publicad/i);
        expect(copy).toMatch(/\{(label|title)\}/);
      }
    }
    // Every other site: as before.
    expect(deleteConfirmKey("post", false, { neverPublished: true })).toBe(
      "sandbox.postEditor.deletePostConfirmBody",
    );
  });
});
