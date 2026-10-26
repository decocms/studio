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
import { BlockConflictError } from "./decofile-api";

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

/**
 * A hosted v8 save that couldn't read the draft's changes (it needs them
 * for its precondition): nothing was sent. The user is told to check their
 * connection and edit again; their change is still in the form.
 */
export class HostedDraftUnreadError extends Error {
  constructor() {
    super("The draft's changes couldn't be read");
    this.name = "HostedDraftUnreadError";
  }
}

/**
 * A hosted v8 change refused round after round (someone kept changing the
 * same blocks): the reconcile flow stopped asking. The draft's latest copy
 * is shown; the user is told to check it and make the change again.
 */
export class HostedKeptChangingError extends Error {
  constructor() {
    super("The blocks kept changing while the change was saved");
    this.name = "HostedKeptChangingError";
  }
}

/**
 * A hosted dead end ({@link HostedDraftUnreadError},
 * {@link HostedKeptChangingError}) with its message in the editor's words,
 * so any toast that shows an error's message guides the user too. Other
 * errors are left as they are.
 */
export function inPlainWords(t: TFunction, error: unknown): unknown {
  if (
    error instanceof HostedDraftUnreadError ||
    error instanceof HostedKeptChangingError
  ) {
    error.message = saveErrorMessage(t, error, "github");
  }
  return error;
}

export function saveErrorMessage(
  t: TFunction,
  error: Error,
  source: ContentSource | null,
): string {
  if (error instanceof HostedDraftUnreadError) {
    return t("siteEditor.save.draftUnread");
  }
  if (error instanceof HostedKeptChangingError) {
    return t("siteEditor.save.keptChanging");
  }
  // An outdated copy, already replaced by the stored one: its message says
  // so in the editor's words, on every backend.
  if (error instanceof BlockConflictError) return error.message;
  if (source === "local") return localSaveErrorMessage(t, error);
  if (error instanceof ContentProtocolError) {
    switch (error.code) {
      case ErrorCode.Conflict:
        return t("siteEditor.save.conflict");
      case ErrorCode.ReadOnly:
        return t("siteEditor.save.readOnly");
      case ErrorCode.InvalidBlock:
      case ErrorCode.InvalidParams:
        return t("siteEditor.save.invalid");
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
  if (
    source === "local" ||
    error instanceof BlockConflictError ||
    error instanceof HostedDraftUnreadError ||
    error instanceof HostedKeptChangingError
  ) {
    return null;
  }
  if (error instanceof ContentProtocolError) {
    // A refused block: which fields to fix, in the server's own words.
    const message =
      error.code === ErrorCode.InvalidBlock ||
      error.code === ErrorCode.InvalidParams
        ? violationsDetail(error)
        : error.message;
    return message ? `${error.code}: ${message}` : null;
  }
  return error.message || null;
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
