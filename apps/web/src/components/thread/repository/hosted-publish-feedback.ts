/**
 * What a hosted Publish tells the user, in business words: one toast per
 * Publish (sonner id `site-editor-publish`, shared with the Releases
 * screen), and the dialog's inline error when nothing was
 * published. "Published" says your site will show it shortly; the API's codes and texts only ever
 * reach the Details disclosure.
 */

import { toast } from "sonner";
import type { TFunction } from "@/i18n/use-t.ts";
import {
  FRESH_TOAST,
  SITE_EDITOR_PUBLISH_TOAST,
  errorDetail,
  toastPublished,
} from "@/components/sections-editor/site-editor-toast.tsx";
import {
  HostedPublishError,
  type HostedPublishResult,
} from "./hosted-publish-api.ts";

/** The one toast for a finished Publish: it is live once it answers. */
export function notifyHostedPublish(t: TFunction, result: HostedPublishResult) {
  if (result.result === "up-to-date") {
    // toast.message, not toast(): only the typed calls replace a toast with
    // the same id; a bare toast() always adds one.
    toast.message(t("siteEditor.publish.nothingToPublish"), {
      ...FRESH_TOAST,
      id: SITE_EDITOR_PUBLISH_TOAST,
      description: t("siteEditor.publish.everythingPublished"),
    });
    return;
  }
  toastPublished(t);
}

/** A Publish that published nothing: the dialog's inline error. */
export function hostedPublishFailure(
  t: TFunction,
  error: unknown,
): { message: string; detail: string | null } {
  // Someone else published in between, three times over (contract §4.9).
  if (
    error instanceof HostedPublishError &&
    error.code === "production_moved"
  ) {
    return {
      message: t("siteEditor.publish.publishedMeanwhile"),
      detail: null,
    };
  }
  return {
    message: t("siteEditor.publish.failed"),
    detail: errorDetail(error),
  };
}
