/**
 * A store analysis running with no earlier result to show: each page, the
 * stage it is at and the engine's note on its progress.
 */

import { AlertCircle, Check } from "@untitledui/icons";
import { Card } from "@decocms/ui/components/card.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { StorePage } from "./diagnosis-schema.ts";
import { PAGE_LABEL, stageLabel } from "./labels.ts";

function PageRow({ page }: { page: StorePage }) {
  const t = useT();
  const stageKey = page.stage ? stageLabel(page.stage) : null;
  const stage =
    page.status === "done"
      ? t("plan.opportunities.running.done")
      : page.status === "error"
        ? t("plan.opportunities.running.failed")
        : stageKey
          ? t(stageKey)
          : page.stage;
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-lg px-3 py-2.5",
        page.status === "running" && "bg-muted",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {page.status === "running" ? (
          <Spinner size="2xs" />
        ) : page.status === "done" ? (
          <Check className="size-4 text-success" />
        ) : (
          <AlertCircle className="size-4 text-destructive" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-foreground">
          {t(PAGE_LABEL[page.page_type])}
        </span>
        {page.progress_note && (
          <span className="text-xs text-muted-foreground">
            {page.progress_note}
          </span>
        )}
      </span>
      {stage && (
        <span className="shrink-0 text-right text-xs text-muted-foreground">
          {stage}
        </span>
      )}
    </li>
  );
}

export function RunStatus({ pages }: { pages: StorePage[] }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("plan.opportunities.running.eyebrow")}
        </p>
        <h2 className="text-xl font-medium text-foreground">
          {t("plan.opportunities.running.heading")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("plan.opportunities.running.description")}
        </p>
      </div>
      <Card size="tile">
        <ul className="flex flex-col gap-1">
          {pages.map((page) => (
            <PageRow key={page.page_type} page={page} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
