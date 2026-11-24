/** "Create business case" on a loss's ready hypothesis: busy while the case
 *  starts, with the failure inline under it. */

import { AlertCircle, ArrowRight } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { CaseCreation } from "./use-create-case.ts";

export function CreateCaseButton({
  creation,
  onClick,
  variant,
  className,
}: {
  creation?: CaseCreation;
  onClick: () => void;
  variant?: "default" | "outline";
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Button
        variant={variant}
        disabled={creation?.disabled}
        aria-busy={creation?.busy}
        onClick={onClick}
      >
        {creation?.busy && <Spinner size="xs" />}
        {t("plan.opportunities.card.createCase")}
        {!creation?.busy && <ArrowRight />}
      </Button>
      {creation?.failed && (
        <div
          className="flex items-start gap-2 text-xs text-destructive"
          role="alert"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span>{t("plan.opportunities.createCase.failed")}</span>
            {creation.error && (
              <span className="break-words text-muted-foreground">
                {creation.error}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
