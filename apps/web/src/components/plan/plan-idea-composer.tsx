/**
 * "What do you want to improve in the store?" — the idea becomes a chat with
 * the agent, which writes the business case with the business-case skill and
 * saves it to the organization's files.
 */

import { useState, type FormEvent } from "react";
import { ArrowRight } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { useChatTask } from "@/components/chat";
import { usePlanObjective } from "@/hooks/use-organization-settings";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { businessCasePrompt } from "./business-case-prompt.ts";

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

export function PlanIdeaComposer() {
  const t = useT();
  const { createTaskWithMessage } = useChatTask();
  const objective = usePlanObjective();
  const [idea, setIdea] = useState("");
  const ready = idea.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    track("plan_idea_submitted", { has_objective: !!objective });
    createTaskWithMessage({
      message: {
        parts: [
          {
            type: "text",
            text: businessCasePrompt(t, {
              idea,
              objective: objective?.statement,
            }),
          },
        ],
      },
    });
    setIdea("");
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
      <form onSubmit={submit} className="flex flex-col gap-3 surface p-4">
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
          className="min-h-28 bg-transparent text-[15px] shadow-none hover:bg-transparent"
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
