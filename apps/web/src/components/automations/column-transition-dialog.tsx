/**
 * Add a `board_column_transition` starter: the column a card enters, and
 * which moves into it count — from any column, from an earlier or a later
 * one, or from named columns.
 */

import { useAutomationActions } from "@/hooks/use-automations";
import { HIDDEN_STATUSES, laneHeader } from "@/layouts/task-board/config";
import { useT } from "@/i18n/use-t.ts";
import {
  CANONICAL_COLUMN_KEYS,
  type CanonicalColumnKey,
} from "@decocms/shared/task-board";
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
import { cn } from "@decocms/ui/lib/utils.ts";
import { useState } from "react";
import { toast } from "sonner";

const COLUMNS = CANONICAL_COLUMN_KEYS.filter(
  (key) => !HIDDEN_STATUSES.includes(key),
);

const ORIGIN_KINDS = ["any", "earlier", "later", "statuses"] as const;
type OriginKind = (typeof ORIGIN_KINDS)[number];

const isColumn = (value: string): value is CanonicalColumnKey =>
  COLUMNS.some((key) => key === value);
const isOriginKind = (value: string): value is OriginKind =>
  ORIGIN_KINDS.some((kind) => kind === value);

export function ColumnTransitionDialog({
  automationId,
  open,
  onOpenChange,
}: {
  automationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { triggerAdd } = useAutomationActions();
  const [column, setColumn] = useState<CanonicalColumnKey>("in_progress");
  const [kind, setKind] = useState<OriginKind>("any");
  const [statuses, setStatuses] = useState<string[]>([]);

  const otherColumns = COLUMNS.filter((key) => key !== column);
  const chosen = statuses.filter((key) => key !== column);
  const ready = kind !== "statuses" || chosen.length > 0;

  const close = (next: boolean) => {
    if (!next) {
      setColumn("in_progress");
      setKind("any");
      setStatuses([]);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    try {
      await triggerAdd.mutateAsync({
        automation_id: automationId,
        type: "board_column_transition",
        column_key: column,
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
      ? t("automations.columnTransitionDialog.fromAny")
      : k === "earlier"
        ? t("automations.columnTransitionDialog.fromEarlier")
        : k === "later"
          ? t("automations.columnTransitionDialog.fromLater")
          : t("automations.columnTransitionDialog.fromColumns");

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("automations.columnTransitionDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("automations.columnTransitionDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground">
              {t("automations.columnTransitionDialog.column")}
            </span>
            <Select
              value={column}
              onValueChange={(v) => {
                if (isColumn(v)) setColumn(v);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COLUMNS.map((key) => {
                  const { label, visual } = laneHeader(key, t);
                  const LaneIcon = visual.icon;
                  return (
                    <SelectItem key={key} value={key}>
                      <LaneIcon
                        size={14}
                        className={cn("shrink-0", visual.iconClassName)}
                      />
                      {label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground">
              {t("automations.columnTransitionDialog.origin")}
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
                key={column}
                options={otherColumns.map((key) => ({
                  label: laneHeader(key, t).label,
                  value: key,
                }))}
                defaultValue={chosen}
                onValueChange={setStatuses}
                placeholder={t(
                  "automations.columnTransitionDialog.columnsPlaceholder",
                )}
                // Inside a modal dialog, a non-modal popover can't be clicked.
                modalPopover
                className="max-w-none"
              />
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {t("automations.columnTransitionDialog.help")}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            {t("automations.columnTransitionDialog.cancel")}
          </Button>
          <Button disabled={!ready || triggerAdd.isPending} onClick={submit}>
            {t("automations.columnTransitionDialog.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
