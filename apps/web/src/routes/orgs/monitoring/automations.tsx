/**
 * Automations Tab — pick an automation, see its runs + token/cost scoped to the
 * dashboard time range. Reuses the shared AutomationRunsView.
 */

import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { useT } from "@/i18n/use-t.ts";
import { useAutomation, useAutomations } from "@/hooks/use-automations";
import { AutomationRunsView } from "@/views/automations/automation-runs";
import type { DateRange } from "./utils.ts";

export function AutomationsTabContent({ dateRange }: { dateRange: DateRange }) {
  const t = useT();
  const { data: automations = [], isLoading } = useAutomations(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const effectiveId = selectedId ?? automations[0]?.id ?? null;
  const { data: automation } = useAutomation(effectiveId ?? "");

  const range = {
    startDate: dateRange.startDate.toISOString(),
    endDate: dateRange.endDate.toISOString(),
  };

  return (
    <div className="flex-1 flex flex-col overflow-auto min-w-0">
      <div className="mx-auto w-full max-w-[1200px] px-4 md:px-10 flex flex-col flex-1 min-h-0 gap-5 pt-1">
        {isLoading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {t("orgs.automations.loading")}
          </div>
        ) : automations.length === 0 ? (
          <div className="py-16">
            <EmptyState
              title={t("orgs.automations.emptyTitle")}
              description={t("orgs.automations.emptyDescription")}
            />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Select
                value={effectiveId ?? ""}
                onValueChange={(v) => setSelectedId(v)}
              >
                <SelectTrigger className="w-72">
                  <SelectValue
                    placeholder={t("orgs.automations.selectPlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {automations.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {automation ? (
              <AutomationRunsView
                automationId={automation.id}
                triggerIds={automation.triggers.map((t) => t.id)}
                range={range}
              />
            ) : (
              <div className="py-16 text-center text-sm text-muted-foreground">
                {t("orgs.automations.loading")}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
