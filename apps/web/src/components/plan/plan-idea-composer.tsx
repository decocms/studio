/** The request opens a chat with its business case canvas beside it. */

import { useState, type FormEvent } from "react";
import { ArrowRight } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  businessCaseMountPath,
  businessCasePath,
} from "@decocms/shared/business-case";
import { useChatTask } from "@/components/chat";
import { formatCaseTabId } from "@/layouts/main-panel-tabs/tab-id";
import { usePlanObjective } from "@/hooks/use-organization-settings";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { businessCasePrompt } from "./business-case-prompt.ts";
import { writeCaseSeed } from "./business-case/case-seed.ts";

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
    const threadId = crypto.randomUUID();
    const casePath = businessCasePath(threadId);
    writeCaseSeed(sessionStorage, casePath, {
      objective: objective?.statement,
      request: idea,
    });
    createTaskWithMessage({
      id: threadId,
      tabId: formatCaseTabId(casePath),
      message: {
        parts: [
          {
            type: "text",
            text: businessCasePrompt(t, {
              idea,
              objective: objective?.statement,
              casePath: businessCaseMountPath(casePath),
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
