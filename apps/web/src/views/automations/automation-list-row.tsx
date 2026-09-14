import { useState } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Clock, DotsVertical, Trash01, Zap } from "@untitledui/icons";
import { useVirtualMCP } from "@/sdk";
import { AgentAvatar } from "@/components/agent-icon";
import { useT } from "@/i18n/use-t.ts";
import {
  useAutomationActions,
  type AutomationListItem,
} from "@/hooks/use-automations";

export function AutomationListRow({
  automation,
  showAgent,
  onClick,
}: {
  automation: AutomationListItem;
  showAgent?: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const { remove } = useAutomationActions();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const agent = useVirtualMCP(
    showAgent ? automation.virtual_mcp_id : undefined,
  );

  const handleDelete = () => {
    remove.mutate(automation.id);
    setConfirmOpen(false);
  };

  return (
    <>
      <div className="group flex w-full items-center border-b border-border transition-colors last:border-b-0 hover:bg-muted/50 focus-within:bg-muted/50">
        <button
          type="button"
          onClick={onClick}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span
            role="img"
            className={cn(
              "inline-block size-2 shrink-0 rounded-full",
              automation.active && automation.trigger_count > 0
                ? "bg-success"
                : "bg-muted-foreground/40",
            )}
            aria-label={t(
              automation.active && automation.trigger_count > 0
                ? "automations.automationListRow.ariaActive"
                : !automation.active
                  ? "automations.automationListRow.ariaPaused"
                  : "automations.automationListRow.ariaNoTriggers",
            )}
          />

          {showAgent && (
            <AgentAvatar
              icon={agent?.icon ?? null}
              name={agent?.title ?? automation.name}
              size="xs"
              className="shrink-0"
            />
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">
                {automation.name}
              </span>
              {showAgent && agent && (
                <span className="truncate text-xs text-muted-foreground">
                  · {agent.title}
                </span>
              )}
            </div>
            <TriggerSummary
              triggerCount={automation.trigger_count}
              nextRunAt={automation.nearest_next_run_at}
            />
          </div>
        </button>

        <div className="shrink-0 pr-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("automations.automationListRow.actionsLabel", {
                  name: automation.name,
                })}
                className="h-8 w-8 p-0 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 data-[state=open]:opacity-100"
              >
                <DotsVertical size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
              >
                <Trash01 size={16} />
                {t("automations.automationListRow.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("automations.automationListRow.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("automations.automationListRow.deleteDescription", {
                name: automation.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("automations.automationListRow.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={remove.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("automations.automationListRow.deleteButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TriggerSummary({
  triggerCount,
  nextRunAt,
}: {
  triggerCount: number;
  nextRunAt: string | null;
}) {
  const t = useT();
  if (triggerCount === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {t("automations.automationListRow.noTriggers")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
      {nextRunAt ? (
        <>
          <Clock size={12} className="shrink-0" />
          <span className="truncate">
            {t("automations.automationListRow.nextRun", {
              date: new Date(nextRunAt).toLocaleString(),
            })}
          </span>
        </>
      ) : (
        <>
          <Zap size={12} className="shrink-0" />
          <span className="truncate">
            {t("automations.automationListRow.triggers", {
              count: triggerCount,
            })}
          </span>
        </>
      )}
    </span>
  );
}
