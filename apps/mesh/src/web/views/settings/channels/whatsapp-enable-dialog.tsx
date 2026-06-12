import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import {
  invalidateChannels,
  useAgentOptions,
  useChannelClient,
} from "@/web/hooks/collections/use-channels";

/**
 * WhatsApp is a shared-number, enable-only channel — no wizard. Pick the agent
 * that answers and activate. Members link their phone in their own profile.
 */
export function WhatsAppEnableDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { org, client } = useChannelClient();
  const agentOptions = useAgentOptions();
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState("");

  const enable = useMutation({
    mutationFn: async () => {
      await client.callTool({
        name: "CHANNEL_CREATE",
        arguments: { channelType: "whatsapp", agentId },
      });
    },
    onSuccess: () => {
      invalidateChannels(queryClient, org.id);
      toast.success("WhatsApp enabled");
      onOpenChange(false);
    },
    onError: (err) => toast.error(`Failed to enable WhatsApp: ${err.message}`),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Enable WhatsApp</DialogTitle>
          <DialogDescription>
            Members chat with this agent over the shared decoCMS WhatsApp
            number. They link their phone in their profile, then message the
            concierge number.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            Agent that answers
          </Label>
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Select an agent…" />
            </SelectTrigger>
            <SelectContent>
              {agentOptions.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!agentId || enable.isPending}
            onClick={() => enable.mutate()}
          >
            {enable.isPending ? "Enabling…" : "Enable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
