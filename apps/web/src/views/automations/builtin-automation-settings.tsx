/**
 * A built-in automation's settings: what it does, and whether it is on. It
 * can't be edited; its runs follow the board's column instructions, which is
 * where an org customizes it.
 */

import { TriggerCard } from "@/components/automations/trigger-card.tsx";
import {
  type AutomationDetail,
  useAutomationActions,
} from "@/hooks/use-automations";
import { useT } from "@/i18n/use-t.ts";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";

export function BuiltinAutomationSettings({
  automation,
}: {
  automation: AutomationDetail;
}) {
  const t = useT();
  const { update } = useAutomationActions();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium text-foreground">
            {automation.name}
          </h2>
          <Badge variant="muted">{t("automations.builtin.badge")}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={automation.active}
            disabled={update.isPending}
            onCheckedChange={(active) =>
              update.mutate({ id: automation.id, active })
            }
            className="cursor-pointer"
          />
          <span className="text-sm text-muted-foreground">
            {automation.active
              ? t("automations.automationDetail.active")
              : t("automations.automationDetail.inactive")}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <span className="text-xs font-semibold text-muted-foreground/60">
          {t("automations.automationDetail.starter")}
        </span>
        {automation.triggers.map((trigger) => (
          <TriggerCard
            key={trigger.id}
            trigger={trigger}
            automationId={automation.id}
            readOnly
          />
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        <span className="text-xs font-semibold text-muted-foreground/60">
          {t("automations.automationDetail.instructions")}
        </span>
        <p className="text-sm text-muted-foreground">
          {automation.system_key === "implementer"
            ? t("automations.builtin.implementerDescription")
            : automation.system_key === "reviewer"
              ? t("automations.builtin.reviewerDescription")
              : automation.system_key === "linked_chats"
                ? t("automations.builtin.linkedChatsDescription")
                : automation.system_key === "pr_merged"
                  ? t("automations.builtin.prMergedDescription")
                  : automation.system_key === "chat_pr"
                    ? t("automations.builtin.chatPrDescription")
                    : automation.system_key === "agent_mentions"
                      ? t("automations.builtin.mentionsDescription")
                      : t("automations.builtin.description")}
        </p>
      </div>
    </div>
  );
}
