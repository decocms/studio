/**
 * "Tenho uma ideia": the button beside the goal, and the screen it opens in
 * place of the Plan page. The idea written there starts the guided intro that
 * ends in a business case, so the screen looks like that intro's first step.
 */

import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Lightbulb01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { WORD_MS, Words } from "./guide/guide-screens.tsx";

/** A topic chip and the sentence it starts. */
const TOPICS: { label: TranslationKey; prompt: TranslationKey }[] = [
  {
    label: "plan.idea.topic.shipping",
    prompt: "plan.idea.topic.shippingPrompt",
  },
  { label: "plan.idea.topic.pdp", prompt: "plan.idea.topic.pdpPrompt" },
  {
    label: "plan.idea.topic.checkout",
    prompt: "plan.idea.topic.checkoutPrompt",
  },
  { label: "plan.idea.topic.search", prompt: "plan.idea.topic.searchPrompt" },
  {
    label: "plan.idea.topic.performance",
    prompt: "plan.idea.topic.performancePrompt",
  },
  {
    label: "plan.idea.topic.paidMedia",
    prompt: "plan.idea.topic.paidMediaPrompt",
  },
];

export function ProposeIdeaButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <Button size="sm" className="group" onClick={onClick}>
      <Lightbulb01 />
      {t("plan.idea.open")}
      <ArrowRight className="transition-transform duration-200 group-hover:translate-x-0.5" />
    </Button>
  );
}

export function PlanIdeaScreen({
  initialIdea,
  onSubmit,
  onBack,
}: {
  initialIdea: string;
  onSubmit: (idea: string) => void;
  /** Back to the Plan page, keeping what was written. */
  onBack: (idea: string) => void;
}) {
  const t = useT();
  const [idea, setIdea] = useState(initialIdea);
  const ready = idea.trim().length > 0;
  const heading = t("plan.idea.heading");
  // The rest comes in once the heading has been read in.
  const restAt = heading.split(/\s+/).length * WORD_MS + 150;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    onSubmit(idea);
  };

  return (
    <div className="flex h-full min-h-0 flex-col animate-in fade-in-0 duration-300 motion-reduce:animate-none">
      <div className="flex items-center gap-3 px-4 pt-4 md:px-8 animate-in fade-in-0 slide-in-from-top-1 duration-500 motion-reduce:animate-none">
        <Button variant="ghost" size="sm" onClick={() => onBack(idea)}>
          <ArrowLeft />
          {t("plan.guide.back")}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto">
        <div className="m-auto flex w-full max-w-2xl justify-center px-4 py-10 md:px-8">
          <form onSubmit={submit} className="flex w-full flex-col gap-6">
            <div className="flex flex-col gap-3">
              <h2 className="text-2xl font-medium text-balance text-foreground md:text-3xl">
                <Words text={heading} delay={0} />
              </h2>
              <p
                className="plan-guide-reveal text-base text-pretty text-muted-foreground"
                style={{ animationDelay: `${restAt}ms` }}
              >
                {t("plan.idea.description")}
              </p>
            </div>
            <div
              className="flex flex-col gap-6 animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none"
              style={{ animationDelay: `${restAt + 150}ms` }}
            >
              <Textarea
                autoFocus
                aria-label={t("plan.idea.label")}
                placeholder={t("plan.idea.placeholder")}
                value={idea}
                onChange={(event) => setIdea(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    submit(event);
                  }
                }}
                className="min-h-32 text-[15px]"
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-1 text-meta">
                  {t("plan.idea.startWith")}
                </span>
                {TOPICS.map((topic) => (
                  <Button
                    key={topic.label}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() =>
                      setIdea((current) => current || t(topic.prompt))
                    }
                  >
                    {t(topic.label)}
                  </Button>
                ))}
              </div>
              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={!ready}
                  className="group transition-all duration-200"
                >
                  {t("plan.idea.submit")}
                  <ArrowRight className="transition-transform duration-200 group-hover:translate-x-0.5" />
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
