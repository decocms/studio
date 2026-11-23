/** Offers an intro an earlier visit left without a case chat. */

import { ArrowRight } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { GuideDraft } from "./guide-draft.ts";

export function PlanGuideResume({
  draft,
  onResume,
  onDiscard,
}: {
  draft: GuideDraft;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  return (
    <section
      aria-label={t("plan.guide.resume.heading")}
      className="flex flex-col gap-3 rounded-xl border border-border bg-muted/40 p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">
          {t("plan.guide.resume.heading")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("plan.guide.resume.description")}
        </p>
      </div>
      <p className="line-clamp-2 text-sm text-foreground">{draft.idea}</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
          {t("plan.guide.resume.discard")}
        </Button>
        <Button type="button" size="sm" onClick={onResume}>
          {t("plan.guide.resume.continue")}
          <ArrowRight />
        </Button>
      </div>
    </section>
  );
}
