/**
 * Add Starter Popover for automation triggers.
 * Provides quick schedule presets and custom cron input.
 */

import { useAutomationActions } from "@/web/hooks/use-automations";
import { SCHEDULE_UNITS } from "@/web/lib/cron-utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Clock, Plus, Globe01, Zap } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";

export function AddStarterPopover({
  automationId,
  open,
  onOpenChange,
  onCustomSelect,
  onEventSelect,
  onWebhookCreated,
}: {
  automationId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCustomSelect?: () => void;
  onEventSelect?: () => void;
  // Called after a webhook trigger is created — receives the one-time
  // URL + token so the parent can show the reveal dialog.
  onWebhookCreated?: (secret: { url: string; token: string }) => void;
}) {
  const { triggerAdd: addTrigger } = useAutomationActions();
  const [internalOpen, setInternalOpen] = useState(false);

  const isOpen = open ?? internalOpen;

  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange ? onOpenChange(newOpen) : setInternalOpen(newOpen);
  };

  const submitCron = async (cron: string) => {
    try {
      await addTrigger.mutateAsync({
        automation_id: automationId,
        type: "cron",
        cron_expression: cron,
      });
      toast.success("Starter added");
      handleOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add starter";
      toast.error(message);
    }
  };

  const submitWebhook = async () => {
    try {
      const result = await addTrigger.mutateAsync({
        automation_id: automationId,
        type: "webhook",
      });
      handleOpenChange(false);
      if (result.webhook) {
        onWebhookCreated?.(result.webhook);
      } else {
        toast.success("Webhook starter added");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add webhook starter";
      toast.error(message);
    }
  };

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus size={14} />
          Add Starter
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px]">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2.5">
            <Clock size={14} className="text-muted-foreground shrink-0" />
            Every...
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[160px]">
            {SCHEDULE_UNITS.map((unit) => (
              <DropdownMenuItem
                key={unit.cron}
                className="gap-2.5"
                onSelect={() => submitCron(unit.cron)}
                disabled={addTrigger.isPending}
              >
                <Clock size={14} className="text-muted-foreground shrink-0" />
                Every {unit.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuItem
          className="gap-2.5"
          onSelect={() => {
            handleOpenChange(false);
            onCustomSelect?.();
          }}
        >
          <Clock size={14} className="text-muted-foreground shrink-0" />
          Custom (cron)
        </DropdownMenuItem>

        <DropdownMenuItem
          className="gap-2.5"
          onSelect={() => {
            handleOpenChange(false);
            onEventSelect?.();
          }}
        >
          <Zap size={14} className="text-muted-foreground shrink-0" />
          Event
        </DropdownMenuItem>

        <DropdownMenuItem
          className="gap-2.5"
          onSelect={() => {
            // Don't close the popover synchronously — we want the toast/
            // dialog flow to be driven by submitWebhook.
            submitWebhook();
          }}
          disabled={addTrigger.isPending}
        >
          <Globe01 size={14} className="text-muted-foreground shrink-0" />
          Webhook
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
