/**
 * Runs the Plan page's guided intro: asks the fast model for each question,
 * keeps the thinking screen up long enough to read as thinking, and opens the
 * business case chat once the intro is over (or the model fails).
 *
 * Driven from event handlers, not effects: each step's call starts where the
 * person acts, and a step they leave is aborted and its reply dropped.
 * Each step is saved until the case chat exists, and comes back as `saved`.
 */

import { useRef, useState } from "react";
import { sleep } from "@decocms/shared/std";
import {
  BUSINESS_CASE_LIMITS,
  businessCaseMountPath,
  businessCasePath,
} from "@decocms/shared/business-case";
import { useChatTask } from "@/components/chat";
import { formatCaseTabId } from "@/layouts/main-panel-tabs/tab-id";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { businessCasePrompt } from "../business-case-prompt.ts";
import { writeCaseSeed } from "../business-case/case-seed.ts";
import {
  clearGuideDraft,
  guideFromDraft,
  readGuideDraft,
  writeGuideDraft,
  type GuideDraft,
} from "./guide-draft.ts";
import {
  guideAnswers,
  guideReducer,
  startGuide,
  type GuideAction,
  type GuideState,
} from "./guide-state.ts";

/** Below this the "thinking" screen flashes instead of reading as thought. */
const MIN_THINKING_MS = 1600;
/** The last beat before the case opens. */
const BUILDING_MS = 2200;

/** The goal a case is started toward: its sentence, and its id when the
 *  org has Plan goals (the single store goal has none). */
export interface GuideGoal {
  statement: string | null;
  id: string | null;
}

export function usePlanGuide(goal: GuideGoal) {
  const t = useT();
  const studio = useStudioTools();
  const { createTaskWithMessage } = useChatTask();
  const objective = goal.statement;
  const { org } = useProjectContext();
  const [state, setState] = useState<GuideState | null>(null);
  /** An intro saved by an earlier visit that never got its case chat. Read
   *  once on mount: an intro running now is not an interrupted one. */
  const [saved, setSaved] = useState<GuideDraft | null>(() =>
    readGuideDraft(localStorage, org.id),
  );
  const current = useRef<AbortController | null>(null);
  /** Whether the guide's screen is still on the page: leaving the Plan page
   *  mid-intro must not open a case later. */
  const shown = useRef(false);

  const show = (next: GuideState) => {
    setState(next);
    writeGuideDraft(localStorage, org.id, next);
  };

  const openCase = async (final: GuideState) => {
    const answers = guideAnswers(final);
    track("plan_guide_done", {
      has_objective: !!objective,
      questions: final.answers.length,
      skipped: final.answers.filter((a) => !a.answer).length,
      guided: final.view.phase === "building" && final.view.guided,
    });
    const threadId = crypto.randomUUID();
    const casePath = businessCasePath(threadId);
    if (goal.id) {
      // A chat that then fails to open writes no case file, so nothing lists.
      studio
        .call("PLAN_GOAL_CASE_RECORD", {
          goal_id: goal.id,
          thread_id: threadId,
        })
        .catch(() => {});
    }
    writeCaseSeed(sessionStorage, casePath, {
      objective,
      request: final.idea,
      title: final.title,
    });
    const created = await createTaskWithMessage({
      id: threadId,
      tabId: formatCaseTabId(casePath),
      message: {
        parts: [
          {
            type: "text",
            text: businessCasePrompt(t, {
              idea: final.idea,
              objective,
              casePath: businessCaseMountPath(casePath),
              ...(answers ? { answers } : {}),
            }),
          },
        ],
      },
    });
    if (created) clearGuideDraft(localStorage, org.id);
  };

  /** Show `next` (a thinking step) and ask the model what comes after it. */
  const think = async (next: GuideState) => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    const { signal } = controller;
    show(next);

    let action: GuideAction;
    try {
      const [result] = await Promise.all([
        studio.call("PLAN_CASE_NEXT_QUESTION", {
          idea: next.idea.slice(0, BUSINESS_CASE_LIMITS.text),
          objective,
          answers: next.answers.map(({ question, answer }) => ({
            question: question.slice(0, BUSINESS_CASE_LIMITS.item),
            answer: answer.slice(0, BUSINESS_CASE_LIMITS.text),
          })),
        }),
        sleep(MIN_THINKING_MS, { signal }),
      ]);
      action = { type: "resolved", step: next.step, result };
    } catch {
      action = { type: "failed", step: next.step };
    }
    if (signal.aborted) return;
    const after = guideReducer(next, action);
    show(after);
    if (after.view.phase !== "building") return;

    try {
      await sleep(BUILDING_MS, { signal });
    } catch {
      return;
    }
    current.current = null;
    // Left the page meanwhile: the saved draft brings it back next visit.
    if (!shown.current) return;
    setState(null);
    void openCase(after);
  };

  return {
    state,
    /** An earlier intro that never opened its case. */
    saved,
    /** Picks the saved intro up: opens its case if it was over, otherwise
     *  asks the next question. */
    resume: () => {
      const draft = readGuideDraft(localStorage, org.id);
      setSaved(null);
      if (!draft) return;
      const resumed = guideFromDraft(draft);
      track("plan_guide_resumed", {
        questions: resumed.answers.length,
        done: resumed.view.phase === "building",
      });
      if (resumed.view.phase === "building") {
        void openCase(resumed);
        return;
      }
      void think(resumed);
    },
    discard: () => {
      clearGuideDraft(localStorage, org.id);
      setSaved(null);
    },
    /** Ref for the guide's root element. */
    screenRef: (node: HTMLElement | null) => {
      shown.current = node !== null;
    },
    start: (idea: string) => {
      if (!idea.trim()) return;
      track("plan_idea_submitted", { has_objective: !!objective });
      setSaved(null);
      void think(startGuide(idea));
    },
    /** An empty answer skips the question. */
    answer: (answer: string) => {
      if (!state) return;
      const next = guideReducer(state, {
        type: "answered",
        step: state.step,
        answer,
      });
      if (next === state) return;
      track("plan_guide_question_answered", {
        step: state.step,
        skipped: !answer.trim(),
      });
      void think(next);
    },
    /** The last question again, its answer filled in. */
    back: () => {
      if (!state) return;
      const next = guideReducer(state, { type: "back", step: state.step });
      if (next === state) return;
      current.current?.abort();
      current.current = null;
      track("plan_guide_back", { step: state.step });
      show(next);
    },
    /** Leaves an intro with answers: they stay saved for the resume card. */
    exit: () => {
      current.current?.abort();
      current.current = null;
      setState(null);
      setSaved(readGuideDraft(localStorage, org.id));
    },
    /** Back to the composer, which takes the idea; nothing to resume. */
    cancel: () => {
      current.current?.abort();
      current.current = null;
      clearGuideDraft(localStorage, org.id);
      setState(null);
    },
  };
}

export type PlanGuide = ReturnType<typeof usePlanGuide>;
