/**
 * What each column is for, as people read it: who acts there and when a
 * person steps in. The lane meanings themselves are `LANES` in shared; this
 * is their user-facing side, read by the lane tooltip and the column sheet.
 */

import {
  CANONICAL_COLUMN_KEYS,
  type CanonicalColumnKey,
} from "@decocms/shared/task-board";
import type { TranslationKey } from "@/i18n/use-t";

export type ColumnActor = "agent" | "person" | "customer" | "none";

const COLUMN_GUIDE: Record<
  CanonicalColumnKey,
  { actor: ColumnActor; purpose: TranslationKey; human: TranslationKey | null }
> = {
  triage: {
    actor: "person",
    purpose: "taskBoard.columnGuide.triage.purpose",
    human: "taskBoard.columnGuide.triage.human",
  },
  todo: {
    actor: "person",
    purpose: "taskBoard.columnGuide.todo.purpose",
    human: "taskBoard.columnGuide.todo.human",
  },
  in_progress: {
    actor: "agent",
    purpose: "taskBoard.columnGuide.inProgress.purpose",
    human: "taskBoard.columnGuide.inProgress.human",
  },
  in_review: {
    actor: "agent",
    purpose: "taskBoard.columnGuide.inReview.purpose",
    human: "taskBoard.columnGuide.inReview.human",
  },
  qa: {
    actor: "person",
    purpose: "taskBoard.columnGuide.qa.purpose",
    human: "taskBoard.columnGuide.qa.human",
  },
  customer_approval: {
    actor: "customer",
    purpose: "taskBoard.columnGuide.customerApproval.purpose",
    human: "taskBoard.columnGuide.customerApproval.human",
  },
  ready_for_deployment: {
    actor: "person",
    purpose: "taskBoard.columnGuide.readyForDeployment.purpose",
    human: "taskBoard.columnGuide.readyForDeployment.human",
  },
  post_deploy_validation: {
    actor: "person",
    purpose: "taskBoard.columnGuide.postDeployValidation.purpose",
    human: "taskBoard.columnGuide.postDeployValidation.human",
  },
  done: {
    actor: "none",
    purpose: "taskBoard.columnGuide.done.purpose",
    human: null,
  },
  archived: {
    actor: "none",
    purpose: "taskBoard.columnGuide.archived.purpose",
    human: null,
  },
};

export const ACTOR_LABEL: Record<ColumnActor, TranslationKey> = {
  agent: "taskBoard.columnGuide.actor.agent",
  person: "taskBoard.columnGuide.actor.person",
  customer: "taskBoard.columnGuide.actor.customer",
  none: "taskBoard.columnGuide.actor.none",
};

/** The guide for a column key, or null for one the board doesn't have. */
export function columnGuide(key: string) {
  const known = CANONICAL_COLUMN_KEYS.find((k) => k === key);
  return known ? COLUMN_GUIDE[known] : null;
}
