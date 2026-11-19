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
  onOpenDocument,
  onAsk,
}: {
  value: BusinessCase;
  invalid?: boolean;
  onOpenDocument?: (documentPath: string) => void;
  /** Sends an open question to this case's chat; absent without one. */
  onAsk?: (question: string) => void;
}) {
  const story = caseStory(value);
  return (
    <div className="@container mx-auto flex w-full max-w-[880px] flex-col gap-10">
      <CaseHero
        value={value}
        story={story}
        invalid={invalid}
        onOpenDocument={onOpenDocument}
      />
      <CaseSpine value={value} story={story} onAsk={onAsk} />
    </div>
  );
}
