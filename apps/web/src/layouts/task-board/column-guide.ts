/**
 * What each column is for, in one sentence people read: what happens there
 * and what moves a card on. The lane meanings themselves are `LANES` in
 * shared; this is their user-facing side, read by the lane's info tooltip and
 * the column sheet. Done and Archived have nothing to explain.
 */

import {
  CANONICAL_COLUMN_KEYS,
  type CanonicalColumnKey,
} from "@decocms/shared/task-board";
import type { TranslationKey } from "@/i18n/use-t";

const COLUMN_SENTENCE: Record<CanonicalColumnKey, TranslationKey | null> = {
  triage: "taskBoard.columnGuide.triage",
  todo: "taskBoard.columnGuide.todo",
  in_progress: "taskBoard.columnGuide.inProgress",
  in_review: "taskBoard.columnGuide.inReview",
  qa: "taskBoard.columnGuide.qa",
  customer_approval: "taskBoard.columnGuide.customerApproval",
  ready_for_deployment: "taskBoard.columnGuide.readyForDeployment",
  post_deploy_validation: "taskBoard.columnGuide.postDeployValidation",
  done: null,
  archived: null,
};

/** The sentence for a column key, or null for one with nothing to explain. */
export function columnSentence(key: string): TranslationKey | null {
  const known = CANONICAL_COLUMN_KEYS.find((k) => k === key);
  return known ? COLUMN_SENTENCE[known] : null;
}
