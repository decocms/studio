/**
 * Why a save or upload to the content protocol failed, in words: a conflict
 * with a change made on disk, a read-only `deco serve`, content it refused,
 * or a server that stopped answering. Anything else keeps the generic
 * "Save failed" with the error's own text (the GitHub backend and the legacy
 * paths throw their own messages).
 */

import {
  type BlockViolation,
  ContentProtocolError,
  ErrorCode,
} from "@decocms/blocks/protocol";
import type { TFunction } from "@/i18n/use-t.ts";

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

export function saveErrorMessage(t: TFunction, error: Error): string {
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
