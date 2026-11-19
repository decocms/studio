/**
 * The guided intro's screens, in place of the Plan page while it runs: a
 * quiet thinking state with passing thoughts, one question at a time, and a last beat
 * before the business case opens.
 */

import { ArrowLeft } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { BUILDING, Question, THINKING, Thinking } from "./guide-screens.tsx";
import type { GuideState } from "./guide-state.ts";
import type { PlanGuide as PlanGuideControls } from "./use-plan-guide.ts";

/** One dot per answered question, and a wider one for the current. */
function Progress({ state }: { state: GuideState }) {
  const asking = state.view.phase === "asking";
  const count = state.answers.length + (asking ? 1 : 0);
  if (count === 0) return null;
  return (
    <div className="ml-auto flex items-center gap-1.5" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 rounded-full transition-all duration-500 animate-in zoom-in-0 fade-in-0 motion-reduce:animate-none",
            asking && i === count - 1
              ? "w-5 bg-foreground"
              : "w-1.5 bg-muted-foreground/40",
          )}
        />
      ))}
    </div>
  );
}

function Screen({
  state,
  onAnswer,
}: {
  state: GuideState;
  onAnswer: (answer: string) => void;
}) {
  const { view } = state;
  switch (view.phase) {
    case "thinking":
      return (
        <Thinking
          phrases={THINKING}
          offset={state.step * 3 + state.idea.length}
        />
      );
    case "asking":
      return <Question key={state.step} view={view} onAnswer={onAnswer} />;
    case "building":
      return <Thinking phrases={BUILDING} offset={0} building />;
  }
}

export function PlanGuide({
  guide,
}: {
  guide: PlanGuideControls & { state: GuideState };
}) {
  const t = useT();
  return (
    <div
      ref={guide.screenRef}
      className="flex h-full min-h-0 flex-col animate-in fade-in-0 duration-300 motion-reduce:animate-none"
    >
      <div className="flex items-center gap-3 px-4 pt-4 md:px-8 animate-in fade-in-0 slide-in-from-top-1 duration-500 motion-reduce:animate-none">
        <Button variant="ghost" size="sm" onClick={guide.cancel}>
          <ArrowLeft />
          {t("plan.guide.back")}
        </Button>
        <p className="min-w-0 truncate text-sm text-muted-foreground">
          <span className="text-meta mr-2">{t("plan.guide.yourIdea")}</span>
          {guide.state.idea}
        </p>
        <Progress state={guide.state} />
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto">
        <div className="m-auto flex w-full max-w-2xl justify-center px-4 py-10 md:px-8">
          <Screen state={guide.state} onAnswer={guide.answer} />
        </div>
      </div>
    </div>
  );
}
