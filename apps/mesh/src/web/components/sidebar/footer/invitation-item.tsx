import {
  authClient,
  invalidateOrganizationListCache,
} from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import { Check, XClose } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import type { Invitation } from "@/web/hooks/use-pending-invitations";

export function InvitationItem({ invitation }: { invitation: Invitation }) {
  const [isAccepting, setIsAccepting] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const queryClient = useQueryClient();

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      const result = await authClient.organization.acceptInvitation({
        invitationId: invitation.id,
      });
      if (result.error) {
        toast.error(result.error.message);
        setIsAccepting(false);
        return;
      }
    } catch {
      toast.error("Failed to accept invitation");
      setIsAccepting(false);
      return;
    }

    // Acceptance succeeded. Fetch org slug for redirect without mutating the
    // session's active org (avoids cross-tab leak — see shell-layout.tsx).
    // A failure here should not surface as "failed to accept" — fall back to
    // the root and let the post-redirect flow pick a default org.
    toast.success("Invitation accepted!");
    // Membership changed — drop the cached org list so the home loader sees
    // the newly joined org.
    invalidateOrganizationListCache();
    let slug: string | undefined;
    try {
      const orgResult = await authClient.organization.getFullOrganization({
        query: { organizationId: invitation.organizationId },
      });
      slug = orgResult?.data?.slug;
    } catch {
      // Ignore — redirect to "/" below.
    }
    window.location.href = slug ? `/${slug}` : "/";
  };

  const handleReject = async () => {
    setIsRejecting(true);
    try {
      const result = await authClient.organization.rejectInvitation({
        invitationId: invitation.id,
      });
      if (result.error) {
        toast.error(result.error.message);
        setIsRejecting(false);
      } else {
        toast.success("Invitation declined");
        queryClient.invalidateQueries();
      }
    } catch {
      toast.error("Failed to decline invitation");
      setIsRejecting(false);
    }
  };

  return (
    <div className="flex items-center gap-3 px-5 py-4 border-b border-border last:border-0 hover:bg-muted/25 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground">
          You&apos;ve been invited to join
        </p>
        <p className="text-sm font-medium truncate">
          {invitation.organizationName ?? "Unknown organization"}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
          onClick={handleAccept}
          disabled={isAccepting || isRejecting}
          aria-label="Accept invitation"
        >
          <Check size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={handleReject}
          disabled={isAccepting || isRejecting}
          aria-label="Decline invitation"
        >
          <XClose size={14} />
        </Button>
      </div>
    </div>
  );
}
