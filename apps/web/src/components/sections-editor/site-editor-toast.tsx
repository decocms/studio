/**
 * The site editor's toasts: one per user action. Each kind of action reuses
 * one sonner id, so a retry, a burst of failing autosaves or a follow-up
 * outcome replaces the toast on screen instead of stacking another one.
 * Developer detail (an error's own text, a status code) sits behind a
 * "Details" disclosure, never in the headline.
 */

import { toast } from "sonner";
import type { TFunction } from "@/i18n/use-t.ts";
import type { ContentSource } from "./content-backend";
import { saveErrorDetail, saveErrorMessage } from "./serve-save-error";

/** Every save failure in the site editor shares this toast. */
export const SITE_EDITOR_SAVE_TOAST = "site-editor-save";
/**
 * The options every save toast starts from (`{ ...SAVE_TOAST, … }`). Sonner
 * merges a toast into the one with the same id, even one already closed, so
 * each toast resets what it doesn't set: a description, an action, a cancel
 * never carry over from the toast before it.
 */
export const SAVE_TOAST = {
  id: SITE_EDITOR_SAVE_TOAST,
  description: undefined,
  action: undefined,
  cancel: undefined,
} as const;
/**
 * A toast with an Undo (deleting a test or a campaign) has its own id.
 * Sonner merges a toast into the one with the same id, even one already
 * closed, so sharing the save id would leave its Undo on every later save
 * toast ("Saved in your draft", "Test added", a save failure).
 */
export const SITE_EDITOR_UNDO_TOAST = "site-editor-undo";
/** Publishing from the editor or reapplying a version from the Releases
 *  screen, its outcome and a retry of it share this toast. */
export const SITE_EDITOR_PUBLISH_TOAST = "site-editor-publish";

/** A collapsed "Details" line holding the developer detail of a failure. */
export function ErrorDetails({
  label,
  detail,
}: {
  label: string;
  detail: string;
}) {
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground">
        {label}
      </summary>
      <p className="mt-1 whitespace-pre-wrap break-words font-mono text-muted-foreground">
        {detail}
      </p>
    </details>
  );
}

/** A toast `description` for `detail`, or nothing when there is none. */
export function errorDetailsDescription(t: TFunction, detail: string | null) {
  return detail ? (
    <ErrorDetails label={t("siteEditor.details")} detail={detail} />
  ) : undefined;
}

/** A failed save, as one toast (replacing an earlier save failure's). */
export function toastSaveError(
  t: TFunction,
  error: Error,
  source: ContentSource | null,
) {
  toast.error(saveErrorMessage(t, error, source), {
    ...SAVE_TOAST,
    description: errorDetailsDescription(t, saveErrorDetail(error, source)),
  });
}

/**
 * The reconcile flow's answer was to keep what the draft holds (their
 * version, or their deletion): one calm toast in place of the save's own,
 * saying how to get the change back.
 */
export function toastKeptTheirs(
  t: TFunction,
  deleted: boolean,
  /**
   * The block left deleted was never published (`neverPublishedBlock`):
   * Publish lists no deletion of it, so none is offered as the way back.
   */
  neverPublished = false,
) {
  toast.info(
    deleted
      ? t("sectionsEditor.reconcile.leftDeleted")
      : t("sectionsEditor.reconcile.keptTheirs"),
    {
      ...SAVE_TOAST,
      // Left deleted: undone the one way the deleted panel says too.
      description: deleted
        ? neverPublished
          ? t("sectionsEditor.reconcile.leftDeletedNeverPublishedHint")
          : t("sectionsEditor.reconcile.leftDeletedHint")
        : t("sectionsEditor.reconcile.keptTheirsHint"),
    },
  );
}

/**
 * Sonner merges an update into the toast with the same id, so an outcome
 * clears what an earlier one set (a failure's "Try again", its stay-open).
 */
export const FRESH_TOAST = { action: undefined, duration: undefined } as const;

/**
 * Published, in one line: your site (or `host`, when the publish names where
 * it goes) will show it shortly. Never "live": a CDN takes a moment.
 */
export function toastPublished(t: TFunction, host?: string | null) {
  toast.success(
    host
      ? t("siteEditor.publish.publishedOn", { host })
      : t("siteEditor.publish.published"),
    { ...FRESH_TOAST, id: SITE_EDITOR_PUBLISH_TOAST, description: undefined },
  );
}

/**
 * Publishing didn't finish: `headline` says so in plain words, `detail` (the
 * error's own text) sits behind Details, and `retry` offers "Try again".
 * `tone: "warning"` when nothing is lost (the changes are saved). `pending`
 * is what the toast says while the retry runs (default "Publishing…").
 */
export function toastPublishFailed(
  t: TFunction,
  {
    headline,
    body,
    detail,
    retry,
    pending,
    tone = "error",
  }: {
    headline: string;
    body?: string;
    detail?: string | null;
    retry?: () => void;
    pending?: string;
    tone?: "error" | "warning";
  },
) {
  const details = errorDetailsDescription(t, detail ?? null);
  toast[tone](headline, {
    id: SITE_EDITOR_PUBLISH_TOAST,
    description:
      body && details ? (
        <>
          <p>{body}</p>
          {details}
        </>
      ) : (
        (body ?? details)
      ),
    action: retry
      ? {
          label: t("siteEditor.tryAgain"),
          onClick: (event) => {
            // Sonner deletes a toast 200ms after its action is clicked, which
            // would take a fast retry's outcome (same id) down with it. Keep
            // the toast: it turns into "Publishing…" (also blocking a second
            // click) until the retry's outcome replaces it.
            event.preventDefault();
            toast.loading(pending ?? t("thread.publishPopover.publishing"), {
              ...FRESH_TOAST,
              id: SITE_EDITOR_PUBLISH_TOAST,
              description: undefined,
            });
            retry();
          },
        }
      : undefined,
    // A failure waits for the user: it carries the next step.
    duration: retry ? Number.POSITIVE_INFINITY : undefined,
  });
}

/** The developer detail of a failed request, for Details. */
export function errorDetail(error: unknown): string | null {
  if (error instanceof Error) return error.message || null;
  return error == null ? null : String(error);
}
