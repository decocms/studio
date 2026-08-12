import { authClient, invalidateOrganizationListCache } from "@/lib/auth-client";
import { AccessScreenLayout } from "@/components/access-screen-layout";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Mail01 } from "@untitledui/icons";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";

export interface PendingInviteScreenProps {
  invitationId: string;
  orgName: string;
  orgSlug: string;
  orgLogo: string | null;
}

export function PendingInviteScreen({
  invitationId,
  orgName,
  orgSlug,
  orgLogo,
}: PendingInviteScreenProps) {
  const t = useT();
  const acceptMutation = useMutation({
    mutationFn: async () => {
      const result = await authClient.organization.acceptInvitation({
        invitationId,
      });
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: () => {
      // Membership changed — drop the cached org list so the home loader sees
      // the newly joined org.
      invalidateOrganizationListCache();
      window.location.href = `/${orgSlug}`;
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("common.pendingInviteScreen.failedToAccept"),
      );
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async () => {
      const result = await authClient.organization.rejectInvitation({
        invitationId,
      });
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: () => {
      toast.success(t("common.pendingInviteScreen.invitationDeclined"));
      window.location.href = "/";
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("common.pendingInviteScreen.failedToDecline"),
      );
    },
  });

  const isBusy = acceptMutation.isPending || rejectMutation.isPending;

  return (
    <AccessScreenLayout>
      {orgLogo ? (
        <Avatar
          url={orgLogo}
          fallback={orgName.charAt(0).toUpperCase()}
          shape="square"
          size="base"
          className="h-12 w-12"
        />
      ) : (
        <div className="bg-primary/10 p-3 rounded-full">
          <Mail01 className="h-6 w-6 text-primary" />
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">
          {t("common.pendingInviteScreen.invitedTo", { orgName })}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("common.pendingInviteScreen.acceptDescription")}
        </p>
      </div>
      <div className="flex flex-col gap-2 w-full">
        <Button onClick={() => acceptMutation.mutate()} disabled={isBusy}>
          {acceptMutation.isPending
            ? t("common.pendingInviteScreen.acceptingButton")
            : t("common.pendingInviteScreen.acceptButton")}
        </Button>
        <Button
          variant="ghost"
          onClick={() => rejectMutation.mutate()}
          disabled={isBusy}
        >
          {rejectMutation.isPending
            ? t("common.pendingInviteScreen.decliningButton")
            : t("common.pendingInviteScreen.declineButton")}
        </Button>
      </div>
    </AccessScreenLayout>
  );
}
