/**
 * The channel accounts (Slack, Discord…) connected to the person: bots there
 * act as them when one of these writes. Connecting happens from the link a
 * bot sends; here they see and disconnect.
 */
import { useState } from "react";
import { MessageChatSquare, Trash01 } from "@untitledui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@decocms/ui/components/button.tsx";
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
import { toast } from "@decocms/ui/components/sonner.tsx";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import { channelName } from "@/lib/channel-accounts";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";

interface Account {
  channel: string;
  accountId: string;
  accountName: string;
  accountWhere: string | null;
}

export function ChannelAccountsSection() {
  const t = useT();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id ?? "";
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Account | null>(null);
  const key = KEYS.channelAccounts(org.id, userId);

  const accounts = useQuery({
    queryKey: key,
    queryFn: () => studio.call("CHANNEL_ACCOUNT_LIST", {}),
    enabled: Boolean(userId),
  });

  const disconnect = useMutation({
    mutationFn: (a: Account) =>
      studio.call("CHANNEL_ACCOUNT_DISCONNECT", {
        channel: a.channel,
        accountId: a.accountId,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
      toast.success(t("settings.channelAccounts.disconnected"));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const list = accounts.data?.accounts ?? [];
  // Nothing to show until a bot sent a link and the person connected.
  if (accounts.isPending || list.length === 0) return null;

  return (
    <SettingsSection
      title={t("settings.channelAccounts.title")}
      description={t("settings.channelAccounts.description")}
    >
      <SettingsCard>
        {list.map((a) => {
          const name = channelName(a.channel);
          return (
            <SettingsCardItem
              key={`${a.channel}:${a.accountId}`}
              icon={<MessageChatSquare size={16} />}
              title={a.accountName || a.accountId}
              description={
                a.accountWhere ? `${name} · ${a.accountWhere}` : name
              }
              action={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("settings.channelAccounts.disconnect")}
                  disabled={disconnect.isPending}
                  onClick={() => setPending(a)}
                >
                  <Trash01 size={14} />
                </Button>
              }
            />
          );
        })}
      </SettingsCard>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.channelAccounts.disconnectTitle", {
                name: pending?.accountName ?? "",
                channel: pending ? channelName(pending.channel) : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.channelAccounts.disconnectDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.channelAccounts.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) disconnect.mutate(pending);
                setPending(null);
              }}
            >
              {t("settings.channelAccounts.disconnect")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
