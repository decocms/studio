/**
 * The guided intro as it stands, kept in the browser until its case chat
 * exists. The intro's state lives in the Plan page, so leaving the page,
 * a reload, or a failed hand-off would otherwise throw away the idea and
 * every answer. Plan offers to pick it up from here.
 */

import { BUSINESS_CASE_LIMITS } from "@decocms/shared/business-case";
import { z } from "zod";
import type { GuideState } from "./guide-state.ts";

const PREFIX = "studio:plan-guide-draft:";
/** An intro nobody came back to in a week is not worth offering. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The idea as typed; the model and the case each cut their own copy. */
const IDEA_MAX = 4000;
/** Above the intro's own question limit, so only a corrupt entry hits it. */
const ANSWERS_MAX = 10;

const GuideDraftSchema = z.object({
  idea: z.string().trim().min(1).max(IDEA_MAX),
  answers: z
    .array(
      z.object({
        question: z.string().min(1).max(BUSINESS_CASE_LIMITS.item),
        answer: z.string().max(BUSINESS_CASE_LIMITS.text),
      }),
    )
    .max(ANSWERS_MAX),
  title: z.string().min(1).max(BUSINESS_CASE_LIMITS.title).nullable(),
  /** Set once the intro is over (`guided` as in the building view); only
   *  opening the case is left. */
  done: z.object({ guided: z.boolean() }).nullable(),
  savedAt: z.number(),
});

export type GuideDraft = z.infer<typeof GuideDraftSchema>;

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const key = (orgId: string) => PREFIX + orgId;

export function writeGuideDraft(
  storage: DraftStorage,
  orgId: string,
  state: GuideState,
  now = Date.now(),
): void {
  const draft: GuideDraft = {
    idea: state.idea.slice(0, IDEA_MAX),
    answers: state.answers
      .slice(0, ANSWERS_MAX)
      .map(({ question, answer }) => ({
        question: question.slice(0, BUSINESS_CASE_LIMITS.item),
        answer: answer.slice(0, BUSINESS_CASE_LIMITS.text),
      })),
    title: state.title?.slice(0, BUSINESS_CASE_LIMITS.title) || null,
    done:
      state.view.phase === "building" ? { guided: state.view.guided } : null,
    savedAt: now,
  };
  try {
    storage.setItem(key(orgId), JSON.stringify(draft));
  } catch {
    // Storage full or blocked: the intro still runs, it just cannot resume.
  }
}

/** The saved intro, or null when there is none, it is too old, or it does
 *  not parse (dropped, so it is not offered again). */
export function readGuideDraft(
  storage: DraftStorage,
  orgId: string,
  now = Date.now(),
): GuideDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key(orgId));
  } catch {
    return null;
  }
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  const draft = GuideDraftSchema.safeParse(json);
  if (!draft.success || now - draft.data.savedAt > MAX_AGE_MS) {
    clearGuideDraft(storage, orgId);
    return null;
  }
  return draft.data;
}

export function clearGuideDraft(storage: DraftStorage, orgId: string): void {
  try {
    storage.removeItem(key(orgId));
  } catch {
    // Blocked storage has nothing to clear.
  }
}

/** The intro where the draft left it: on the next question to ask, or
 *  over and ready to open. */
export function guideFromDraft(draft: GuideDraft): GuideState {
  return {
    step: draft.answers.length,
    idea: draft.idea,
    answers: draft.answers,
    // The draft keeps no options: going back re-asks the text alone.
    asked: draft.answers.map(({ question }) => ({
      text: question,
      options: [],
    })),
    title: draft.title,
    view: draft.done
      ? { phase: "building", guided: draft.done.guided }
      : { phase: "thinking" },
  };
}
