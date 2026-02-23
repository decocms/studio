import { useState } from "react";
import { toast } from "sonner";
import { authenticateMcp, useConnectionActions } from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";

interface SlotAuthOAuthProps {
  connectionId: string;
  providerName: string;
  onAuthed: () => void;
}

export function SlotAuthOAuth({
  connectionId,
  providerName,
  onAuthed,
}: SlotAuthOAuthProps) {
  const [isPending, setIsPending] = useState(false);
  const actions = useConnectionActions();
  const queryClient = useQueryClient();
  const mcpProxyUrl = new URL(`/mcp/${connectionId}`, window.location.origin);

  const handleAuthorize = async () => {
    setIsPending(true);
    try {
      const { token, tokenInfo, error } = await authenticateMcp({
        connectionId,
      });

      if (error || !token) {
        toast.error(`Authorization failed: ${error ?? "Unknown error"}`);
        return;
      }

      if (tokenInfo) {
        const response = await fetch(
          `/api/connections/${connectionId}/oauth-token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              accessToken: tokenInfo.accessToken,
              refreshToken: tokenInfo.refreshToken,
              expiresIn: tokenInfo.expiresIn,
              scope: tokenInfo.scope,
              clientId: tokenInfo.clientId,
              clientSecret: tokenInfo.clientSecret,
              tokenEndpoint: tokenInfo.tokenEndpoint,
            }),
          },
        );
        if (!response.ok) {
          await actions.update.mutateAsync({
            id: connectionId,
            data: { connection_token: token },
          });
        } else {
          // Trigger tool re-discovery
          await actions.update.mutateAsync({ id: connectionId, data: {} });
        }
      } else {
        await actions.update.mutateAsync({
          id: connectionId,
          data: { connection_token: token },
        });
      }

      await queryClient.invalidateQueries({
        queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
      });

      onAuthed();
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Authorize Mesh to access {providerName} on your behalf.
      </p>
      <Button onClick={handleAuthorize} disabled={isPending} className="w-full">
        {isPending ? "Authorizing..." : `Authorize with ${providerName}`}
      </Button>
    </div>
  );
}
