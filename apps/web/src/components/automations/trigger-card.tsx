/**
 * Trigger Card for automation triggers.
 * Displays and allows inline editing of cron-based triggers.
 */

import {
  useAutomationActions,
  type AutomationTrigger,
} from "@/hooks/use-automations";
import { useT } from "@/i18n/use-t.ts";
import { WebhookSecretDialog } from "@/components/automations/webhook-secret-dialog";
import {
  buildCronFromInterval,
  humanReadableCron,
  isValidCron,
  parseCronToInterval,
  unitLabel,
} from "@/lib/cron-utils.ts";
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
  Clock,
  Edit01,
  Globe01,
  Loading01,
  RefreshCw01,
  XClose,
  Zap,
} from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";

export function TriggerCard({
  trigger,
  automationId,
  connectionName,
}: {
  trigger: AutomationTrigger;
  automationId: string;
  connectionName?: string;
}) {
  const t = useT();
  const {
    triggerAdd: addTrigger,
    triggerRemove: removeTrigger,
    triggerRotateToken: rotateToken,
  } = useAutomationActions();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<{
    url: string;
    token: string;
  } | null>(null);

  const interval = trigger.cron_expression
    ? parseCronToInterval(trigger.cron_expression)
    : null;
  const [count, setCount] = useState(interval?.count ?? 1);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(trigger.cron_expression ?? "");

  const isSaving =
    removeTrigger.isPending || addTrigger.isPending || rotateToken.isPending;
  const isCron = trigger.type === "cron";
  const isWebhook = trigger.type === "webhook";

  const handleRemove = async () => {
    try {
      await removeTrigger.mutateAsync({
        trigger_id: trigger.id,
        automation_id: automationId,
      });
      toast.success(t("automations.triggerCard.starterRemoved"));
    } catch {
      toast.error(t("automations.triggerCard.failedToRemoveStarter"));
    }
    setConfirmDelete(false);
  };

  // Cron triggers have no update endpoint: a new schedule is added, then the
  // old trigger row is removed.
  const replaceCronTrigger = async (cronExpression: string) => {
    await addTrigger.mutateAsync({
      automation_id: automationId,
      type: "cron",
      cron_expression: cronExpression,
    });
    await removeTrigger.mutateAsync({
      trigger_id: trigger.id,
      automation_id: automationId,
    });
  };

  const handleEditSave = async () => {
    const val = editValue.trim();
    if (!val || !isValidCron(val) || val === trigger.cron_expression) {
      setIsEditing(false);
      setEditValue(trigger.cron_expression ?? "");
      return;
    }
    try {
      await replaceCronTrigger(val);
      setIsEditing(false);
    } catch {
      toast.error(t("automations.triggerCard.failedToUpdateStarter"));
      setEditValue(trigger.cron_expression ?? "");
      setIsEditing(false);
    }
  };

  const handleRotate = async () => {
    setConfirmRotate(false);
    try {
      const result = await rotateToken.mutateAsync({
        trigger_id: trigger.id,
        automation_id: automationId,
      });
      setRotatedSecret({ url: result.url, token: result.token });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to rotate token";
      toast.error(message);
    }
  };

  const handleCountSave = async (newCount: number) => {
    if (!interval) return;
    const minCount = interval.unit === "minutes" ? 5 : 1;
    const clamped = Math.max(minCount, newCount);
    if (clamped !== newCount) setCount(clamped);
    const newCron = buildCronFromInterval(clamped, interval.unit);
    if (newCron === trigger.cron_expression) return;
    try {
      await replaceCronTrigger(newCron);
    } catch {
      toast.error(t("automations.triggerCard.failedToUpdateStarter"));
      setCount(interval.count);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-border bg-background group">
        {isCron ? (
          <Clock size={14} className="text-muted-foreground shrink-0" />
        ) : isWebhook ? (
          <Globe01 size={14} className="text-muted-foreground shrink-0" />
        ) : (
          <Zap size={14} className="text-muted-foreground shrink-0" />
        )}

        {interval && isCron ? (
          <>
            <span className="text-sm text-muted-foreground">
              {t("automations.triggerCard.every")}
            </span>
            <input
              type="number"
              min={interval.unit === "minutes" ? 5 : 1}
              value={count}
              onChange={(e) => setCount(parseInt(e.target.value) || 1)}
              onBlur={() => handleCountSave(count)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setCount(interval.count);
              }}
              disabled={isSaving}
              className="w-12 text-center text-sm h-7 border border-border rounded-md bg-background px-1 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-sm">{unitLabel(interval.unit, count)}</span>
          </>
        ) : isCron && isEditing ? (
          <>
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleEditSave}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setIsEditing(false);
                  setEditValue(trigger.cron_expression ?? "");
                }
              }}
              className="flex-1 text-sm font-mono bg-transparent outline-none"
              autoFocus
            />
            {editValue && !isValidCron(editValue) && (
              <span className="text-xs text-muted-foreground/60 shrink-0">
                {t("automations.triggerCard.invalid")}
              </span>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-0.5 flex-1 min-w-0">
            <span className="text-sm font-mono text-xs text-muted-foreground truncate">
              {isCron
                ? humanReadableCron(trigger.cron_expression ?? "")
                : isWebhook
                  ? t("automations.triggerCard.webhookPostToFire")
                  : `${trigger.event_type}${connectionName ? ` · ${connectionName}` : ""}`}
            </span>
            {!isCron &&
              !isWebhook &&
              trigger.params &&
              Object.keys(trigger.params).length > 0 && (
                <span className="text-xs text-muted-foreground/60 truncate">
                  {Object.entries(trigger.params)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(", ")}
                </span>
              )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          {isSaving && (
            <Loading01
              size={13}
              className="animate-spin text-muted-foreground"
            />
          )}
          {isCron && !interval && !isEditing && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => {
                setEditValue(trigger.cron_expression ?? "");
                setIsEditing(true);
              }}
            >
              <Edit01 size={13} className="text-muted-foreground" />
            </Button>
          )}
          {isWebhook && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
              title={t("automations.triggerCard.rotateToken")}
              onClick={() => setConfirmRotate(true)}
            >
              <RefreshCw01 size={13} className="text-muted-foreground" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => setConfirmDelete(true)}
          >
            <XClose size={13} className="text-muted-foreground" />
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("automations.triggerCard.removeStarter")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("automations.triggerCard.confirmRemoveStarter")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("automations.triggerCard.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("automations.triggerCard.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("automations.triggerCard.rotateWebhookToken")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("automations.triggerCard.rotateWebhookTokenDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("automations.triggerCard.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleRotate}>
              {t("automations.triggerCard.rotate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <WebhookSecretDialog
        open={rotatedSecret !== null}
        onOpenChange={(open) => {
          if (!open) setRotatedSecret(null);
        }}
        url={rotatedSecret?.url ?? null}
        token={rotatedSecret?.token ?? null}
        title={t("automations.triggerCard.newWebhookToken")}
        description={t("automations.triggerCard.newWebhookTokenDescription")}
      />
    </>
  );
}
