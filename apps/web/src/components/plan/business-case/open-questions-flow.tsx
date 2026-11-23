/**
 * The case's open questions on the guided intro's screens: one at a time, an
 * answer or "find out for me" each, then the cards' last beat while the
 * answers go to the case's chat in one message.
 */

import { useState } from "react";
import { ArrowLeft, XClose } from "@untitledui/icons";
import { sleep } from "@decocms/shared/std";
import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { GuideAnswer } from "../business-case-prompt.ts";
import {
  BUILDING,
  ProgressDots,
  Question,
  Thinking,
} from "../guide/guide-screens.tsx";
import type { OpenFlowProgress } from "./open-flow.ts";

/** The last beat before the canvas comes back, as long as the intro's. */
const BUILDING_MS = 2200;

export function OpenQuestionsFlow({
  title,
  progress,
  onProgress,
  onDone,
  onClose,
}: {
  title: string;
  progress: OpenFlowProgress;
  onProgress: (next: OpenFlowProgress) => void;
  /** Every answer, in order; an empty one was left for the agent. */
  onDone: (answers: GuideAnswer[]) => void;
  /** `finished` once the answers went out; otherwise they stay saved. */
  onClose: (finished: boolean) => void;
}) {
  const t = useT();
  const { questions, answers, step } = progress;
  const [building, setBuilding] = useState(false);

  const answer = (text: string) => {
    if (building) return;
    const next = [...answers];
    next[step] = text;
    if (step + 1 < questions.length) {
      onProgress({ questions, answers: next, step: step + 1 });
      return;
    }
    onDone(
      questions.map((question, i) => ({ question, answer: next[i] ?? "" })),
    );
    setBuilding(true);
    void sleep(BUILDING_MS).then(() => onClose(true));
  };

  return (
    <div className="flex h-full min-h-0 flex-col animate-in fade-in-0 duration-300 motion-reduce:animate-none">
      <div className="flex items-center gap-3 px-4 pt-4 md:px-8 animate-in fade-in-0 slide-in-from-top-1 duration-500 motion-reduce:animate-none">
        {!building && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              step > 0
                ? onProgress({ ...progress, step: step - 1 })
                : onClose(false)
            }
          >
            <ArrowLeft />
            {step > 0 ? t("plan.guide.back") : t("plan.case.openFlow.back")}
          </Button>
        )}
        <p className="min-w-0 truncate py-1.5 text-sm text-muted-foreground">
          <span className="text-meta mr-2">{t("page.businessCase")}</span>
          {title}
        </p>
        <ProgressDots
          done={building ? questions.length : step}
          current={!building}
          total={questions.length}
        />
        {!building && step > 0 && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("plan.case.openFlow.back")}
            title={t("plan.case.openFlow.back")}
            onClick={() => onClose(false)}
          >
            <XClose />
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto">
        <div className="m-auto flex w-full max-w-2xl justify-center px-4 py-10 md:px-8">
          {building ? (
            <Thinking phrases={BUILDING} offset={0} building />
          ) : (
            <Question
              key={step}
              view={{
                question: { text: questions[step]!, options: [] },
                reaction: t("plan.case.openFlow.counter", {
                  n: step + 1,
                  total: questions.length,
                }),
              }}
              initialAnswer={answers[step]}
              skipLabel={t("plan.case.openFlow.skip")}
              onAnswer={answer}
            />
          )}
        </div>
      </div>
    </div>
  );
}
