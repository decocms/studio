import type { TranslationKey } from "@/i18n/use-t.ts";

/**
 * The delete confirmation's text. On a hosted v8 draft a delete is a draft
 * change like any edit: nothing goes live until Publish, and discarding the
 * change brings the block back, so it never says "permanently". Every other
 * site keeps its copy.
 */
export function deleteConfirmKey(
  what: "block" | "post" | "archivedPosts" | "section",
  hostedDraft: boolean,
  {
    neverPublished = false,
    live = false,
  }: {
    /**
     * Hosted v8: the block was never published (`neverPublishedBlock`), so its
     * deletion is no change Publish lists: no way back through Publish is
     * promised.
     */
    neverPublished?: boolean;
    /**
     * A post that is published or scheduled: deleting it takes its page off
     * the site, which a hosted draft's copy already covers by saying nothing
     * goes live until Publish.
     */
    live?: boolean;
  } = {},
): TranslationKey {
  if (hostedDraft && neverPublished) {
    if (what === "post") {
      return "sandbox.postEditor.deletePostConfirmBodyNeverPublished";
    }
    if (what === "archivedPosts") {
      return "sandbox.postBoard.deleteArchivedConfirmBodyNeverPublished";
    }
    return "sandbox.contentBrowser.deleteDialog.descriptionNeverPublished";
  }
  if (what === "section") {
    return hostedDraft
      ? "sandbox.contentBrowser.deleteDialog.descriptionSectionDraft"
      : "sandbox.contentBrowser.deleteDialog.descriptionSection";
  }
  if (what === "archivedPosts") {
    return hostedDraft
      ? "sandbox.postBoard.deleteArchivedConfirmBodyDraft"
      : "sandbox.postBoard.deleteArchivedConfirmBody";
  }
  if (what === "post") {
    if (hostedDraft) return "sandbox.postEditor.deletePostConfirmBodyDraft";
    return live
      ? "sandbox.postEditor.deletePostConfirmBodyLive"
      : "sandbox.postEditor.deletePostConfirmBody";
  }
  return hostedDraft
    ? "sandbox.contentBrowser.deleteDialog.descriptionDraft"
    : "sandbox.contentBrowser.deleteDialog.descriptionPermanent";
}
