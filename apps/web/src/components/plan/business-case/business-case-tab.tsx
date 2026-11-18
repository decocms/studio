/**
 * The case tab beside the chat: the canvas of the case this chat is building.
 * Before the agent's first write it draws what the Plan page sent (the goal
 * and the request), so the person lands on a page that is already taking
 * shape.
 */

import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Page } from "@/components/page";
import { formatLibraryFileTabId } from "@/layouts/main-panel-tabs/tab-id";
import { usePanelNavigate } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useT } from "@/i18n/use-t.ts";
import { BusinessCaseCanvas } from "./business-case-canvas.tsx";
import { readCaseSeed } from "./case-seed.ts";
import { useBusinessCase } from "./use-business-case.ts";

function CaseLoading({ label }: { label?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-2/3" />
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
    </div>
  );
}

export function BusinessCaseTab({ path }: { path: string }) {
  const t = useT();
  const { openPanel } = usePanelNavigate();
  const read = useBusinessCase(path);
  const value = read.data?.value ?? readCaseSeed(sessionStorage, path);

  return (
    <Page>
      <Page.Content>
        <Page.Container width="wide" className="py-8">
          {value ? (
            <BusinessCaseCanvas
              value={value}
              invalid={read.data?.invalid}
              onOpenDocument={(documentPath) =>
                openPanel(formatLibraryFileTabId(`home/${documentPath}`))
              }
            />
          ) : (
            <CaseLoading
              label={read.isPending ? undefined : t("plan.case.waiting")}
            />
          )}
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
