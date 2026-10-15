/**
 * Add a `jira_transition` starter: the Jira status an issue enters, on the
 * board the org's Jira integration watches, and which moves into it count —
 * from any status, from an earlier or a later one, or from named statuses.
 */

import { useAutomationActions } from "@/hooks/use-automations";
import { useJiraBoardColumns } from "@/hooks/use-jira-integration";
import { useT } from "@/i18n/use-t.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { MultiSelect } from "@decocms/ui/components/multi-select.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

const ORIGIN_KINDS = ["any", "earlier", "later", "statuses"] as const;
type OriginKind = (typeof ORIGIN_KINDS)[number];

const isOriginKind = (value: string): value is OriginKind =>
  ORIGIN_KINDS.some((kind) => kind === value);

export function JiraTransitionDialog({
  automationId,
  boardId,
  open,
  onOpenChange,
}: {
  automationId: string;
  boardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { triggerAdd } = useAutomationActions();
  const columns = useJiraBoardColumns(open ? boardId : null);
  const [picked, setPicked] = useState<string | null>(null);
  const [kind, setKind] = useState<OriginKind>("any");
  const [statuses, setStatuses] = useState<string[]>([]);

  // A Jira column is a bucket of statuses; a starter names a status.
  const options = (columns.data ?? []).flatMap((column) =>
    column.statuses.map((status) => ({ column: column.name, status })),
  );
  const status = picked ?? options[0]?.status ?? null;
  const otherStatuses = options
    .map((o) => o.status)
    .filter((s) => s !== status);
  const chosen = statuses.filter((s) => s !== status);
  const ready = status !== null && (kind !== "statuses" || chosen.length > 0);

  const close = (next: boolean) => {
    if (!next) {
      setPicked(null);
      setKind("any");
      setStatuses([]);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    if (!status) return;
    try {
      await triggerAdd.mutateAsync({
        automation_id: automationId,
        type: "jira_transition",
        jira_status: status,
        from: kind === "statuses" ? { kind, statuses: chosen } : { kind },
      });
      toast.success(t("automations.addStarterPopover.starterAdded"));
      close(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("automations.addStarterPopover.failedAddStarter"),
      );
    }
  };

  const originLabel = (k: OriginKind) =>
    k === "any"
      ? t("automations.jiraTransitionDialog.fromAny")
      : k === "earlier"
        ? t("automations.jiraTransitionDialog.fromEarlier")
        : k === "later"
          ? t("automations.jiraTransitionDialog.fromLater")
          : t("automations.jiraTransitionDialog.fromStatuses");

  let statusField: ReactNode;
  if (columns.isPending) {
    statusField = <Skeleton className="h-9 w-full" />;
  } else if (columns.isError || options.length === 0) {
    statusField = (
      <p className="text-xs text-muted-foreground">
        {t("automations.jiraTransitionDialog.noStatuses")}
      </p>
    );
  } else {
    statusField = (
      <Select value={status ?? undefined} onValueChange={setPicked}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.status} value={o.status}>
              {o.status}
              {o.column !== o.status && (
                <span className="text-muted-foreground">{o.column}</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("automations.jiraTransitionDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("automations.jiraTransitionDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground">
              {t("automations.jiraTransitionDialog.status")}
            </span>
            {statusField}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground">
              {t("automations.jiraTransitionDialog.origin")}
            </span>
            <Select
              value={kind}
              onValueChange={(v) => {
                if (isOriginKind(v)) setKind(v);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORIGIN_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {originLabel(k)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {kind === "statuses" && (
              <MultiSelect
                key={status}
                options={otherStatuses.map((s) => ({ label: s, value: s }))}
                defaultValue={chosen}
                onValueChange={setStatuses}
                placeholder={t(
                  "automations.jiraTransitionDialog.statusesPlaceholder",
                )}
                // Inside a modal dialog, a non-modal popover can't be clicked.
                modalPopover
                className="max-w-none"
              />
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {t("automations.jiraTransitionDialog.help")}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            {t("automations.jiraTransitionDialog.cancel")}
          </Button>
          <Button disabled={!ready || triggerAdd.isPending} onClick={submit}>
            {t("automations.jiraTransitionDialog.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
