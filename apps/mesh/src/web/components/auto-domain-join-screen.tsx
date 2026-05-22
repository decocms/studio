import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Building02 } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";

export interface AutoDomainJoinScreenProps {
  orgName: string;
  orgSlug: string;
  orgLogo: string | null;
  domain: string;
}

export function AutoDomainJoinScreen({
  orgName,
  orgSlug,
  orgLogo,
  domain,
}: AutoDomainJoinScreenProps) {
  const [isJoining, setIsJoining] = useState(false);

  const handleJoin = async () => {
    setIsJoining(true);
    try {
      const res = await fetch("/api/auth/custom/domain-join", {
        method: "POST",
        credentials: "include",
      });
      const data = (await res.json()) as {
        success?: boolean;
        slug?: string;
        error?: string;
      };
      if (!res.ok || !data.success) {
        toast.error(data.error ?? "Failed to join organization");
        setIsJoining(false);
        return;
      }
      window.location.href = `/${data.slug ?? orgSlug}`;
    } catch {
      toast.error("Failed to join organization");
      setIsJoining(false);
    }
  };

  const handleGoHome = () => {
    window.location.href = "/";
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
            <Building02 className="h-6 w-6 text-primary" />
          </div>
        )}
        <div className="space-y-2">
          <h3 className="text-lg font-medium">Join {orgName}?</h3>
          <p className="text-sm text-muted-foreground">
            Anyone with an <strong>@{domain}</strong> email can join this
            organization.
          </p>
        </div>
        <div className="flex flex-col gap-2 w-full">
          <Button onClick={handleJoin} disabled={isJoining}>
            {isJoining ? "Joining…" : `Enter ${orgName}`}
          </Button>
          <Button variant="ghost" onClick={handleGoHome} disabled={isJoining}>
            Go to home
          </Button>
        </div>
      </div>
    </div>
  );
}
