/**
 * The screens Plan shows while a business case takes shape: a quiet thinking
 * state with passing thoughts, one question at a time, and the case's cards
 * filling in. The guided intro and a case still being built share them.
 */

import { Fragment, useState, type FormEvent } from "react";
import { ArrowRight } from "@untitledui/icons";
import { BUSINESS_CASE_CARD_KEYS } from "@decocms/shared/business-case";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useClockTick } from "@/lib/use-clock-tick";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import "./plan-guide.css";

export const THINKING: TranslationKey[] = [
  "plan.guide.thinking1",
  "plan.guide.thinking2",
  "plan.guide.thinking3",
  "plan.guide.thinking4",
  "plan.guide.thinking5",
  "plan.guide.thinking6",
  "plan.guide.thinking7",
  "plan.guide.thinking8",
];
export const BUILDING: TranslationKey[] = [
  "plan.guide.building1",
  "plan.guide.building2",
  "plan.guide.building3",
  "plan.guide.building4",
  "plan.guide.building5",
  "plan.guide.building6",
  "plan.guide.building7",
  "plan.guide.building8",
  "plan.guide.building17",
  "plan.guide.building9",
  "plan.guide.building10",
  "plan.guide.building11",
  "plan.guide.building12",
  "plan.guide.building13",
  "plan.guide.building14",
  "plan.guide.building15",
  "plan.guide.building16",
];
const PHRASE_MS = 7000;
/** A thought sits still first, then a light sweeps across it for the rest of
 *  its beat, so a long wait still reads as work in progress. */
const SHIMMER_MS = 5000;
const TILES = BUSINESS_CASE_CARD_KEYS.length;

/** Three quiet dots and a thought that changes every beat. Each step starts
 *  on a different thought, so two waits in a row don't read the same. */
export function Thinking({
  phrases,
  offset,
  building = false,
  filled,
}: {
  phrases: TranslationKey[];
  offset: number;
  /** The case's cards fill in instead of the dots. */
  building?: boolean;
  /** How many cards the agent filled: those tiles stay solid and the rest
   *  wait for it. Without it the tiles fill in as a single beat. */
  filled?: number;
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
          {Array.from({ length: TILES }, (_, i) => (
            <span
              key={i}
              data-tile={
                filled === undefined
                  ? undefined
                  : i < filled
                    ? "filled"
                    : "waiting"
              }
              style={{ animationDelay: `${i * 90}ms` }}
            />
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
        <span
          className="plan-guide-shimmer"
          style={{ animationDelay: `${PHRASE_MS - SHIMMER_MS}ms` }}
        >
          {t(phrase)}
        </span>
      </p>
      {filled !== undefined && filled > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("plan.case.buildingProgress", { filled, total: TILES })}
        </p>
      )}
    </div>
  );
}

/** A heading, one word after the other. */
export function Words({ text, delay }: { text: string; delay: number }) {
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

export const WORD_MS = 45;
const REACTION_MS = 350;

/** A dot per answered question and a wider one for the current. Given a
 *  `total`, the questions still ahead show as faint dots too. */
export function ProgressDots({
  done,
  current,
  total = 0,
}: {
  done: number;
  current: boolean;
  total?: number;
}) {
  const count = Math.max(total, done + (current ? 1 : 0));
  if (count === 0) return null;
  return (
    <div className="ml-auto flex items-center gap-1.5" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 rounded-full transition-all duration-500 animate-in zoom-in-0 fade-in-0 motion-reduce:animate-none",
            current && i === done
              ? "w-5 bg-foreground"
              : i < done
                ? "w-1.5 bg-muted-foreground/40"
                : "w-1.5 bg-muted-foreground/15",
          )}
        />
      ))}
    </div>
  );
}

export interface ScreenQuestion {
  text: string;
  options: string[];
}

/** One question with its options and a free answer. An empty answer is a
 *  skipped question. */
export function Question({
  view,
  onAnswer,
  skipLabel,
  initialAnswer = "",
}: {
  view: { question: ScreenQuestion; reaction: string | null };
  onAnswer: (answer: string) => void;
  skipLabel?: string;
  /** The answer given before the person came back to this question. */
  initialAnswer?: string;
}) {
  const t = useT();
  const [answer, setAnswer] = useState(initialAnswer);
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
            {skipLabel ?? t("plan.guide.skip")}
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
