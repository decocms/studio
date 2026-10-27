import type { TranslationKey } from "@/i18n/use-t.ts";

/**
 * The delete confirmation's text. On a hosted v8 draft a delete is a draft
 * change like any edit: nothing goes live until Publish, and discarding the
 * change brings the block back, so it never says "permanently". Every other
 * site keeps its copy.
 */
export function deleteConfirmKey(
  what: "block" | "post" | "section",
  hostedDraft: boolean,
): TranslationKey {
  if (what === "section") {
    return hostedDraft
      ? "sandbox.contentBrowser.deleteDialog.descriptionSectionDraft"
      : "sandbox.contentBrowser.deleteDialog.descriptionSection";
  }
  if (what === "post") {
    return hostedDraft
      ? "sandbox.postEditor.deletePostConfirmBodyDraft"
      : "sandbox.postEditor.deletePostConfirmBody";
  }
  return hostedDraft
    ? "sandbox.contentBrowser.deleteDialog.descriptionDraft"
    : "sandbox.contentBrowser.deleteDialog.descriptionPermanent";
}
