"use client";

import { BookOpen01, Check } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { useT } from "@/i18n/use-t.ts";
import { MessageTextPart } from "../text-part.tsx";

interface ProposePlanPartProps {
  part: ToolUIPart;
}

export function ProposePlanPart({ part }: ProposePlanPartProps) {
  const t = useT();
  // Only render after user has responded
  if (!part.state.startsWith("output-")) {
    return null;
  }

  const plan = (part.input as { plan?: string })?.plan ?? "";
  const approved = (part.output as { approved?: boolean })?.approved;
  const isApproved = approved === true;

  return (
    <div className="my-1.5 flex flex-col gap-1">
      {/* Header */}
      <div className="flex items-center gap-2">
        <BookOpen01 className="size-4 text-purple-500 shrink-0" />
        <span className="text-[14px] font-medium text-foreground/80">
          {t("chat.proposePlan.implementationPlan")}
        </span>
        {isApproved && (
          <span className="flex items-center gap-1 text-xs text-success bg-success/10 px-1.5 py-0.5 rounded-md">
            <Check size={12} />
            {t("chat.proposePlan.approved")}
          </span>
        )}
        {!isApproved && part.state === "output-available" && (
          <span className="text-xs text-muted-foreground/70 italic">
            {t("chat.proposePlan.rejected")}
          </span>
        )}
      </div>

      {/* Plan content (collapsed) */}
      <details className="ml-6">
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
          {t("chat.proposePlan.viewPlan")}
        </summary>
        <div className="mt-1 pl-2 border-l-2 border-purple-500/30 prose prose-sm max-w-none text-sm">
          <MessageTextPart
            id="plan-content"
            part={{ type: "text", text: plan }}
          />
        </div>
      </details>
    </div>
  );
}
