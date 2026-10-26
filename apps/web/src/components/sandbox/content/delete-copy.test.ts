import { describe, expect, it } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import { deleteConfirmKey } from "./delete-copy";

describe("delete confirmations", () => {
  it("a hosted v8 draft's delete is a draft change: never 'permanent', and says how to undo it", () => {
    for (const what of ["block", "post"] as const) {
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
  });
});
