/**
 * What a hosted Publish tells the user, in business words: one toast per
 * Publish (sonner id `site-editor-publish`, shared with its "Try again" and
 * with the Versions screen), and the dialog's inline error when nothing was
 * published. "Published" means live; the API's codes and texts only ever
 * reach the Details disclosure.
 */

import { toast } from "sonner";
import type { TFunction } from "@/i18n/use-t.ts";
import {
  FRESH_TOAST,
  SITE_EDITOR_PUBLISH_TOAST,
  errorDetail,
  toastPublishFailed,
  toastPublished,
} from "@/components/sections-editor/site-editor-toast.tsx";
import {
  HostedPublishError,
  type HostedPublishResult,
} from "./hosted-publish-api.ts";

/**
 * The one toast for a finished Publish. `retry` puts saved-but-not-live
 * changes live (see `publishMainHead`); it is offered whenever the changes
 * reached main but the site doesn't show them yet.
 */
export function notifyHostedPublish(
  t: TFunction,
  result: HostedPublishResult,
  retry: () => void,
) {
  if (result.result === "up-to-date") {
    // toast.message, not toast(): only the typed calls replace a toast with
    // the same id; a bare toast() always adds one.
    toast.message(t("siteEditor.publish.nothingToPublish"), {
      ...FRESH_TOAST,
      id: SITE_EDITOR_PUBLISH_TOAST,
      description: t("siteEditor.publish.everythingLive"),
    });
    return;
  }
  if (result.release === "current") {
    toastPublished(t, t("siteEditor.publish.changesLive"));
    return;
  }
  notifySavedNotPublished(t, null, retry);
}

/** The changes are saved but not live yet: a warning with "Try again". */
export function notifySavedNotPublished(
  t: TFunction,
  error: unknown,
  retry: () => void,
) {
  toastPublishFailed(t, {
    tone: "warning",
    headline: t("siteEditor.publish.savedNotPublished"),
    body: t("siteEditor.publish.savedNotPublishedBody"),
    detail: errorDetail(error),
    retry,
  });
}

/** A Publish that published nothing: the dialog's inline error. */
export function hostedPublishFailure(
  t: TFunction,
  error: unknown,
): { message: string; detail: string | null } {
  if (error instanceof HostedPublishError && error.code === "main-moved") {
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
