/** The request starts the guided intro that ends in a business case. */

import { useState, type FormEvent } from "react";
import { ArrowRight } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";

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

export function PlanIdeaComposer({
  initialIdea,
  onSubmit,
}: {
  initialIdea: string;
  onSubmit: (idea: string) => void;
}) {
  const t = useT();
  const [idea, setIdea] = useState(initialIdea);
  const ready = idea.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    onSubmit(idea);
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-medium text-foreground">
          {t("plan.idea.heading")}
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">
          {t("plan.idea.description")}
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Textarea
          aria-label={t("plan.idea.label")}
          placeholder={t("plan.idea.placeholder")}
          value={idea}
          onChange={(event) => setIdea(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              submit(event);
            }
          }}
          className="min-h-32 text-[15px]"
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={!ready}>
            {t("plan.idea.submit")}
            <ArrowRight />
          </Button>
        </div>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-meta">{t("plan.idea.startWith")}</span>
        {TOPICS.map((topic) => (
          <Button
            key={topic.label}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setIdea((current) => current || t(topic.prompt))}
          >
            {t(topic.label)}
          </Button>
        ))}
      </div>
    </section>
  );
}
