/**
 * The guided intro's screens, in place of the Plan page while it runs: a
 * quiet thinking state with passing thoughts, one question at a time, and a last beat
 * before the business case opens.
 */

import { Fragment, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
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
  building = false,
}: {
  phrases: TranslationKey[];
  offset: number;
  /** The last beat: the case's cards fill in instead of the dots. */
  building?: boolean;
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
      {building ? (
        <div className="plan-guide-tiles" aria-hidden="true">
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      ) : (
        <div className="plan-guide-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
      <p key={phrase} className="plan-guide-reveal text-base">
        <span className="plan-guide-shimmer">{t(phrase)}</span>
      </p>
    </div>
  );
}

/** The question, one word after the other. */
function Words({ text, delay }: { text: string; delay: number }) {
  return text.split(/\s+/).map((word, i) => (
    <Fragment key={i}>
      <span
        className="plan-guide-reveal inline-block"
        style={{ animationDelay: `${delay + i * WORD_MS}ms` }}
      >
        {word}
      </span>{" "}
    </Fragment>
  ));
}

const WORD_MS = 45;
const REACTION_MS = 350;

function Question({
  view,
  onAnswer,
}: {
  view: Extract<GuideView, { phase: "asking" }>;
  onAnswer: (answer: string) => void;
}) {
  const t = useT();
  const [answer, setAnswer] = useState("");
  /** The answer being sent while the screen leaves. */
  const [leaving, setLeaving] = useState<string | null>(null);
  const ready = answer.trim().length > 0;

  const questionAt = view.reaction ? REACTION_MS : 0;
  const optionsAt =
    questionAt + view.question.text.split(/\s+/).length * WORD_MS + 150;
  const inputAt = optionsAt + view.question.options.length * 70 + 100;

  const leave = (value: string) => {
    if (leaving !== null) return;
    // Without motion the exit animation never ends: answer right away.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onAnswer(value);
      return;
    }
    setLeaving(value);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) leave(answer);
  };

  return (
    <form
      onSubmit={submit}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && leaving !== null) {
          onAnswer(leaving);
        }
      }}
      className={cn(
        "flex w-full flex-col gap-6",
        leaving !== null &&
          "animate-out fade-out-0 slide-out-to-top-4 fill-mode-forwards duration-300 delay-150",
      )}
    >
      <div className="flex flex-col gap-3">
        {view.reaction && (
          <p className="plan-guide-reveal text-base text-muted-foreground">
            {view.reaction}
          </p>
        )}
        <h2 className="text-2xl font-medium text-balance text-foreground md:text-3xl">
          <Words text={view.question.text} delay={questionAt} />
        </h2>
      </div>
      {view.question.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {view.question.options.map((option, i) => (
            <Button
              key={option}
              type="button"
              variant="outline"
              aria-pressed={leaving === option}
              className={cn(
                "h-auto rounded-full px-4 py-2 text-left whitespace-normal transition-[background-color,color,opacity,transform] duration-200 hover:-translate-y-0.5 animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none motion-reduce:hover:translate-y-0",
                leaving === option &&
                  "border-foreground bg-foreground text-background hover:bg-foreground hover:text-background",
                leaving !== null && leaving !== option && "opacity-30",
              )}
              style={{ animationDelay: `${optionsAt + i * 70}ms` }}
              onClick={() => leave(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <div
        className="flex flex-col gap-6 animate-in fade-in-0 fill-mode-both duration-500 motion-reduce:animate-none"
        style={{ animationDelay: `${inputAt}ms` }}
      >
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
          className="min-h-24 text-[15px] transition-shadow"
        />
        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={() => leave("")}>
            {t("plan.guide.skip")}
          </Button>
          <Button
            type="submit"
            disabled={!ready}
            className="group transition-all duration-200"
          >
            {t("plan.guide.continue")}
            <ArrowRight className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </Button>
        </div>
      </div>
    </form>
  );
}

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
