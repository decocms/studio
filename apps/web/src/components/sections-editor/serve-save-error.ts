/**
 * Why a save failed, in words for whoever is editing. A local `deco serve`
 * (`source: "local"`) is a developer's own machine: its copy names the
 * server, the disk and git, and keeps the error's own text. Everywhere else
 * (Studio's hosted backend, a sandbox, the legacy paths) the editor is a
 * business user: plain words and a next step, with the error's own text kept
 * for a "Details" disclosure ({@link saveErrorDetail}), never the headline.
 */

import {
  type BlockViolation,
  ContentProtocolError,
  ErrorCode,
} from "@decocms/blocks/protocol";
import type { TFunction } from "@/i18n/use-t.ts";
import type { ContentSource } from "./content-backend";

/** A local `deco serve` request that got no answer (see `guarded`). */
export class ServeLostError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ServeLostError";
  }
}

/** Whether a failed save was refused for an outdated `ifMatch`. */
export function isSaveConflict(error: unknown): boolean {
  return (
    error instanceof ContentProtocolError && error.code === ErrorCode.Conflict
  );
}

function violationsDetail(error: ContentProtocolError): string {
  const violations = (error.data as { violations?: BlockViolation[] } | null)
    ?.violations;
  if (!Array.isArray(violations) || violations.length === 0) {
    return error.message;
  }
  return violations
    .slice(0, 3)
    .map((violation) => violation.message)
    .join("; ");
}

export function saveErrorMessage(
  t: TFunction,
  error: Error,
  source: ContentSource | null,
): string {
  if (source === "local") return localSaveErrorMessage(t, error);
  if (error instanceof ContentProtocolError) {
    switch (error.code) {
      case ErrorCode.Conflict:
        return t("siteEditor.save.conflict");
      case ErrorCode.ReadOnly:
        return t("siteEditor.save.readOnly");
      case ErrorCode.InvalidBlock:
      case ErrorCode.InvalidParams:
        return t("siteEditor.save.invalid", {
          detail: violationsDetail(error),
        });
      case ErrorCode.LimitExceeded:
        return t("siteEditor.save.tooLarge");
    }
  }
  return t("siteEditor.save.failed");
}

/**
 * The error's own text, for the "Details" disclosure under a business-user
 * message; null when the message already says it all (a local `deco serve`,
 * which keeps the text in its message, or an error with no text).
 */
export function saveErrorDetail(
  error: Error,
  source: ContentSource | null,
): string | null {
  if (source === "local") return null;
  const code = error instanceof ContentProtocolError ? `${error.code}: ` : "";
  return error.message ? `${code}${error.message}` : null;
}

function localSaveErrorMessage(t: TFunction, error: Error): string {
  if (error instanceof ServeLostError) return t("decoServe.save.serverGone");
  if (error instanceof ContentProtocolError) {
    switch (error.code) {
      case ErrorCode.Conflict:
        return t("decoServe.save.conflict");
      case ErrorCode.ReadOnly:
        return t("decoServe.save.readOnly");
      case ErrorCode.InvalidBlock:
      case ErrorCode.InvalidParams:
        return t("decoServe.save.invalid", { detail: violationsDetail(error) });
      case ErrorCode.LimitExceeded:
        return t("decoServe.save.tooLarge");
    }
  }
  return t("sectionsEditor.sectionsEditor.saveFailed", {
    error: error.message,
  });
}
