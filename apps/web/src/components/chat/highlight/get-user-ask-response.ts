/**
 * Form value shape for a single user-ask question.
 *
 * - text/confirm questions store `{ response }`
 * - choice questions store `{ option, draft }` where `option` is the
 *   currently selected predefined option (or null), and `draft` is the
 *   user's typed "Something else..." text (persisted across option
 *   selections).
 */
export type UserAskQuestionValue =
  | { response: string }
  | { option: string | null; draft: string };

/**
 * Derive the response string that gets submitted for a question.
 * For choice questions, prefer the selected option; fall back to the draft.
 */
export function getUserAskResponse(
  value: UserAskQuestionValue | undefined,
): string {
  if (!value) return "";
  if ("response" in value) return value.response;
  return value.option ?? value.draft;
}
