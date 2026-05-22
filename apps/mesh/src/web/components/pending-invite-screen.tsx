import { authClient } from "@/web/lib/auth-client";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Mail01 } from "@untitledui/icons";
import { useState } from "react";
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
  const [isAccepting, setIsAccepting] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      const result = await authClient.organization.acceptInvitation({
        invitationId,
      });
      if (result.error) {
        toast.error(result.error.message);
        setIsAccepting(false);
        return;
      }
      window.location.href = `/${orgSlug}`;
    } catch {
      toast.error("Failed to accept invitation");
      setIsAccepting(false);
    }
  };

  const handleReject = async () => {
    setIsRejecting(true);
    try {
      const result = await authClient.organization.rejectInvitation({
        invitationId,
      });
      if (result.error) {
        toast.error(result.error.message);
        setIsRejecting(false);
        return;
      }
      toast.success("Invitation declined");
      window.location.href = "/";
    } catch {
      toast.error("Failed to decline invitation");
      setIsRejecting(false);
    }
  };

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
          <Button onClick={handleAccept} disabled={isAccepting || isRejecting}>
            {isAccepting ? "Accepting…" : "Accept invitation"}
          </Button>
          <Button
            variant="ghost"
            onClick={handleReject}
            disabled={isAccepting || isRejecting}
          >
            {isRejecting ? "Declining…" : "Decline"}
          </Button>
        </div>
      </div>
    </div>
  );
}
