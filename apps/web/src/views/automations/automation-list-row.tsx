import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        className="group w-full flex items-center gap-3 px-4 py-3 border-b border-border text-left hover:bg-muted/50 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={cn(
            "inline-block size-2 rounded-full shrink-0",
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

        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-foreground truncate">
              {automation.name}
            </span>
            {showAgent && agent && (
              <span className="text-xs text-muted-foreground truncate">
                · {agent.title}
              </span>
            )}
          </div>
          <TriggerSummary
            triggerCount={automation.trigger_count}
            nextRunAt={automation.nearest_next_run_at}
          />
        </div>

        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
          className="shrink-0"
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
              >
                <DotsVertical size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmOpen(true);
                }}
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
