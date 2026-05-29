import {
  authClient,
  invalidateOrganizationListCache,
} from "@/web/lib/auth-client";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Mail01 } from "@untitledui/icons";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

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
        error instanceof Error ? error.message : "Failed to accept invitation",
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
      toast.success("Invitation declined");
      window.location.href = "/";
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to decline invitation",
      );
    },
  });

  const isBusy = acceptMutation.isPending || rejectMutation.isPending;

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="flex flex-col items-center text-center space-y-4 max-w-sm px-6">
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
            You&apos;ve been invited to <strong>{orgName}</strong>
          </h3>
          <p className="text-sm text-muted-foreground">
            Accept the invitation to join this organization.
          </p>
        </div>
        <div className="flex flex-col gap-2 w-full">
          <Button onClick={() => acceptMutation.mutate()} disabled={isBusy}>
            {acceptMutation.isPending ? "Accepting…" : "Accept invitation"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => rejectMutation.mutate()}
            disabled={isBusy}
          >
            {rejectMutation.isPending ? "Declining…" : "Decline"}
          </Button>
        </div>
      </div>
    </div>
  );
}
