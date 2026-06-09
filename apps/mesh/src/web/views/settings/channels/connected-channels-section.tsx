import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Edit01, PlayCircle, Trash01 } from "@untitledui/icons";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
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
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import {
  invalidateChannels,
  useChannelClient,
  useChannelPlatforms,
  type ChannelInstance,
  type ChannelStatus,
} from "@/web/hooks/collections/use-channels";

const STATUS_VARIANT: Record<
  ChannelStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  active: "default",
  draft: "secondary",
  error: "destructive",
  disabled: "outline",
};

export interface ResumeTarget {
  platform: ChannelInstance["channelType"];
  channelId: string;
  webhookUrl: string;
  step: "instructions" | "endpoint" | "credentials" | "testing";
}

export function ConnectedChannelsSection({
  channels,
  onAdd,
  onResume,
}: {
  channels: ChannelInstance[];
  onAdd: () => void;
  onResume: (target: ResumeTarget) => void;
}) {
  const platforms = useChannelPlatforms();
  const platformName = (id: string) =>
    platforms.find((p) => p.id === id)?.name ?? id;

  return (
    <SettingsSection>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Connected channels</h3>
        <Button size="sm" variant="outline" onClick={onAdd}>
          Add channel
        </Button>
      </div>
      <SettingsCard>
        {channels.map((channel) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            platformName={platformName(channel.channelType)}
            onResume={onResume}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function ChannelRow({
  channel,
  platformName,
  onResume,
}: {
  channel: ChannelInstance;
  platformName: string;
  onResume: (target: ResumeTarget) => void;
}) {
  const { org, client } = useChannelClient();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const del = useMutation({
    mutationFn: async () => {
      await client.callTool({
        name: "CHANNEL_DELETE",
        arguments: { id: channel.id },
      });
    },
    onSuccess: () => {
      invalidateChannels(queryClient, org.id);
      toast.success("Channel deleted");
      setConfirmDelete(false);
    },
    onError: (err) => toast.error(`Failed to delete: ${err.message}`),
  });

  const resumeTo = (step: ResumeTarget["step"]) =>
    onResume({
      platform: channel.channelType,
      channelId: channel.id,
      webhookUrl: channel.webhookUrl,
      step,
    });

  return (
    <>
      <SettingsCardItem
        icon={
          <Avatar
            fallback={platformName.charAt(0)}
            className="size-8 bg-primary/10 text-primary"
          />
        }
        title={channel.label}
        description={platformName}
        action={
          <div className="flex items-center gap-1.5">
            <Badge variant={STATUS_VARIANT[channel.status]}>
              {channel.status}
            </Badge>
            {channel.status === "draft" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => resumeTo("instructions")}
              >
                <PlayCircle size={14} /> Resume setup
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={() => resumeTo("credentials")}
              >
                <Edit01 size={14} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              disabled={del.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash01 size={14} />
            </Button>
          </div>
        }
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete channel</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the integration and its bot member. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => del.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
