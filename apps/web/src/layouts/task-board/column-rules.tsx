/**
 * How a column works, opened from its lane header: what the column is for and
 * the automations that run on its cards. Read-only on purpose: an automation's
 * instructions and skills are edited on its own page, so the sheet links there
 * instead of being a second place to configure them.
 */

import { useState, type ComponentType } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ChevronRight, Plus, Zap } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@decocms/ui/components/sheet.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useProjectScope } from "@/hooks/use-project-scope";
import { getDecopilotId, useProjectContext } from "@/sdk";
import {
  useAutomationActions,
  useAutomations,
  type AutomationListItem,
} from "@/hooks/use-automations";
import { useT } from "@/i18n/use-t.ts";
import { columnSentence } from "./column-guide";

type Starter = AutomationListItem["board_triggers"][number]["type"];

/** The automations a card dropped in `columnKey` starts: the ones with a
 *  "card enters a column" starter there. */
export function useEntryAutomations(columnKey: string) {
  const { data } = useAutomations();
  return (data ?? []).filter((a) =>
    a.board_triggers.some(
      (t) => t.type === "board_column_transition" && t.column_key === columnKey,
    ),
  );
}

/** Where a starter falls in a card's stay: on arrival, mid-way, on the way out. */
function starterOrder(type: Starter): number {
  switch (type) {
    case "board_column_transition":
      return 0;
    case "board_pr_ready":
      return 1;
    case "board_pr_merged":
      return 2;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function starterLabelKey(type: Starter) {
  switch (type) {
    case "board_column_transition":
      return "taskBoard.columnRules.starter.board_column_transition" as const;
    case "board_pr_ready":
      return "taskBoard.columnRules.starter.board_pr_ready" as const;
    case "board_pr_merged":
      return "taskBoard.columnRules.starter.board_pr_merged" as const;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/** Every automation with a board starter on `columnKey`: the ones that are on
 *  first, then in the order they fire during a card's stay. */
function useColumnAutomations(columnKey: string) {
  const { data } = useAutomations();
  return (data ?? [])
    .flatMap((automation) => {
      const starter = automation.board_triggers.find(
        (s) => s.column_key === columnKey,
      );
      return starter ? [{ automation, starter: starter.type }] : [];
    })
    .sort(
      (a, b) =>
        Number(b.automation.active) - Number(a.automation.active) ||
        starterOrder(a.starter) - starterOrder(b.starter),
    );
}

export function ColumnRulesSheet({
  columnKey,
  label,
  icon: Icon,
  iconClassName,
  open,
  onOpenChange: setOpen,
}: {
  columnKey: string;
  label: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  iconClassName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const sentence = columnSentence(columnKey);
  const automations = useColumnAutomations(columnKey);
  const leave = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        className="w-full gap-0 sm:max-w-md"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <SheetHeader className="gap-1 pb-0">
          <SheetTitle className="flex items-center gap-2">
            {Icon && <Icon size={16} className={iconClassName} />}
            {label}
          </SheetTitle>
          {sentence && (
            <p className="surface-inset mt-2 rounded-xl px-3.5 py-3 text-sm leading-relaxed text-foreground">
              {t(sentence)}
            </p>
          )}
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pt-6 pb-6">
          <h3 className="text-meta">{t("taskBoard.columnRules.runsHere")}</h3>
          {automations.length === 0 ? (
            <EmptyAutomations
              columnKey={columnKey}
              label={label}
              onLeave={leave}
            />
          ) : (
            <div className="surface divide-y divide-border">
              {automations.map(({ automation, starter }) => (
                <Link
                  key={automation.id}
                  to="/$org/projects/$agentId/automations/$automationId"
                  params={{
                    org: org.slug,
                    agentId: automation.virtual_mcp_id,
                    automationId: automation.id,
                  }}
                  onClick={leave}
                  className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/50"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cn(
                        "truncate text-sm",
                        automation.active
                          ? "text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {automation.name}
                    </span>
                    <span className="text-meta">
                      {automation.active
                        ? t(starterLabelKey(starter))
                        : t("taskBoard.columnRules.off")}
                    </span>
                  </span>
                  <ChevronRight
                    size={14}
                    className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                  />
                </Link>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Nothing runs here yet: start an automation already bound to the column,
 *  in the board's project, and open it for editing. */
function EmptyAutomations({
  columnKey,
  label,
  onLeave,
}: {
  columnKey: string;
  label: string;
  onLeave: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const { project } = useProjectScope();
  const navigate = useNavigate();
  const { create, triggerAdd } = useAutomationActions();
  const [creating, setCreating] = useState(false);
  const agentId = project?.id ?? getDecopilotId(org.id);

  const createBound = async () => {
    setCreating(true);
    try {
      const created = await create.mutateAsync({
        name: t("taskBoard.columnRules.newAutomationName", { column: label }),
        messages: [],
        models: { tier: "smart" },
        active: false,
        virtual_mcp_id: agentId,
      });
      await triggerAdd.mutateAsync({
        automation_id: created.id,
        type: "board_column_transition",
        column_key: columnKey,
      });
      onLeave();
      navigate({
        to: "/$org/projects/$agentId/automations/$automationId",
        params: { org: org.slug, agentId, automationId: created.id },
      });
    } catch {
      toast.error(t("taskBoard.columnRules.newAutomationFailed"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="surface flex flex-col items-center gap-3 px-6 py-8 text-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Zap size={16} />
      </span>
      <p className="text-sm font-medium text-foreground">
        {t("taskBoard.columnRules.noAutomations")}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={creating}
        onClick={createBound}
      >
        <Plus size={14} />
        {t("taskBoard.columnRules.newAutomation")}
      </Button>
    </div>
  );
}
