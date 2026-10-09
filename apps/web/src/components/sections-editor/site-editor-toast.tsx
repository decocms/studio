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

/** A collapsed "Details" line holding the developer detail of a failure. */
function ErrorDetails({ label, detail }: { label: string; detail: string }) {
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
    id: SITE_EDITOR_SAVE_TOAST,
    description: errorDetailsDescription(t, saveErrorDetail(error, source)),
  });
}

/** The developer detail of a failed request, for Details. */
export function errorDetail(error: unknown): string | null {
  if (error instanceof Error) return error.message || null;
  return error == null ? null : String(error);
}
