/**
 * The business case as a story: the verdict on top (what it is worth, the
 * effort, the A/B test) and the acts on one rail below, lighting up as the
 * chat fills the case.
 */

import type { BusinessCase } from "@decocms/shared/business-case";
import { CaseHero } from "./case-hero.tsx";
import { CaseSpine } from "./case-spine.tsx";
import { caseStory } from "./case-story.ts";

export function BusinessCaseCanvas({
  value,
  invalid,
  onAsk,
  onAnswerOpen,
}: {
  value: BusinessCase;
  invalid?: boolean;
  /** Sends an open question to this case's chat; absent without one. */
  onAsk?: (question: string) => void;
  /** Opens the flow that asks the case's open questions one at a time;
   *  absent without the case's chat. */
  onAnswerOpen?: (questions: string[]) => void;
}) {
  const story = caseStory(value);
  const answerOpen =
    onAnswerOpen && story.openQuestions.length > 0
      ? () => onAnswerOpen(story.openQuestions)
      : undefined;
  return (
    <div className="@container mx-auto flex w-full max-w-[880px] flex-col gap-10">
      <CaseHero
        value={value}
        story={story}
        invalid={invalid}
        onAnswerOpen={answerOpen}
      />
      <CaseSpine
        value={value}
        story={story}
        onAsk={onAsk}
        onAnswerOpen={answerOpen}
      />
    </div>
  );
}
