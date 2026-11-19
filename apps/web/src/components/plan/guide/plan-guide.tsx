/**
 * The guided intro's screens, in place of the Plan page while it runs: a
 * quiet thinking state with passing thoughts, one question at a time, and a last beat
 * before the business case opens.
 */

import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { useClockTick } from "@/lib/use-clock-tick";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import type { GuideState, GuideView } from "./guide-state.ts";
import type { PlanGuide as PlanGuideControls } from "./use-plan-guide.ts";
import "./plan-guide.css";

const THINKING: TranslationKey[] = [
  "plan.guide.thinking1",
  "plan.guide.thinking2",
  "plan.guide.thinking3",
  "plan.guide.thinking4",
  "plan.guide.thinking5",
  "plan.guide.thinking6",
  "plan.guide.thinking7",
  "plan.guide.thinking8",
];
const BUILDING: TranslationKey[] = [
  "plan.guide.building1",
  "plan.guide.building2",
  "plan.guide.building3",
];
const PHRASE_MS = 900;

/** Three quiet dots and a thought that changes every beat. Each step starts
 *  on a different thought, so two waits in a row don't read the same. */
function Thinking({
  phrases,
  offset,
}: {
  phrases: TranslationKey[];
  offset: number;
}) {
  const t = useT();
  const tick = useClockTick(PHRASE_MS);
  const phrase =
    phrases[(Math.floor(tick / PHRASE_MS) + offset) % phrases.length]!;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center gap-5 animate-in fade-in-0 duration-300 motion-reduce:animate-none"
    >
      <div className="plan-guide-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p
        key={phrase}
        className="text-base animate-in fade-in-0 duration-500 motion-reduce:animate-none"
      >
        <span className="plan-guide-shimmer">{t(phrase)}</span>
      </p>
    </div>
  );
}

function Question({
  view,
  onAnswer,
}: {
  view: Extract<GuideView, { phase: "asking" }>;
  onAnswer: (answer: string) => void;
}) {
  const t = useT();
  const [answer, setAnswer] = useState("");
  const ready = answer.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) onAnswer(answer);
  };

  return (
    <form
      onSubmit={submit}
      className="flex w-full flex-col gap-6 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 motion-reduce:animate-none"
    >
      <div className="flex flex-col gap-3">
        {view.reaction && (
          <p className="text-base text-muted-foreground">{view.reaction}</p>
        )}
        <h2 className="text-2xl font-medium text-balance text-foreground md:text-3xl">
          {view.question.text}
        </h2>
      </div>
      {view.question.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {view.question.options.map((option, i) => (
            <Button
              key={option}
              type="button"
              variant="outline"
              className="h-auto rounded-full px-4 py-2 text-left whitespace-normal animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none"
              style={{ animationDelay: `${150 + i * 80}ms` }}
              onClick={() => onAnswer(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <Textarea
        autoFocus
        aria-label={t("plan.guide.answerLabel")}
        placeholder={t("plan.guide.answerPlaceholder")}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            submit(event);
          }
        }}
        className="min-h-24 text-[15px]"
      />
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={() => onAnswer("")}>
          {t("plan.guide.skip")}
        </Button>
        <Button type="submit" disabled={!ready}>
          {t("plan.guide.continue")}
          <ArrowRight />
        </Button>
      </div>
    </form>
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
      return <Thinking phrases={BUILDING} offset={0} />;
  }
}

export function PlanGuide({
  guide,
}: {
  guide: PlanGuideControls & { state: GuideState };
}) {
  const t = useT();
  return (
    <div ref={guide.screenRef} className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 px-4 pt-4 md:px-8">
        <Button variant="ghost" size="sm" onClick={guide.cancel}>
          <ArrowLeft />
          {t("plan.guide.back")}
        </Button>
        <p className="min-w-0 truncate text-sm text-muted-foreground">
          <span className="text-meta mr-2">{t("plan.guide.yourIdea")}</span>
          {guide.state.idea}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto">
        <div className="m-auto flex w-full max-w-2xl justify-center px-4 py-10 md:px-8">
          <Screen state={guide.state} onAnswer={guide.answer} />
        </div>
      </div>
    </div>
  );
}
