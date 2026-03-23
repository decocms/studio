import { authClient } from "@/web/lib/auth-client";
import {
  useConnectionActions,
  useProjectContext,
  type ConnectionCreateData,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { EmptyState } from "@/web/components/empty-state";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

interface StoreRegistryEmptyStateProps {
  registries: ConnectionCreateData[];
  onConnected?: (createdRegistryId: string) => void;
}

export function StoreRegistryEmptyState({
  registries,
  onConnected,
}: StoreRegistryEmptyStateProps) {
  const actions = useConnectionActions();
  const {
    org: { slug: orgSlug },
  } = useProjectContext();
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  const [isInstalling, setIsInstalling] = useState(false);

  const firstRegistry = registries[0];

  const handleInstallRegistry = async () => {
    if (!firstRegistry || !session?.user?.id) return;

    setIsInstalling(true);
    try {
      const created = await actions.create.mutateAsync(firstRegistry);
      onConnected?.(created.id);
    } finally {
      setIsInstalling(false);
    }
  };

  const handleInstallMcpServer = () => {
    navigate({
      to: "/$org/mcps",
      params: { org: orgSlug },
      search: { action: "create" },
    });
  };

  return (
    <EmptyState
      image={
        <img
          src="/store-empty-state.svg"
          alt="No store connected"
          width={336}
          height={320}
          className="max-w-full h-auto"
        />
      }
      title="Connect to registry"
      description="Connect to discover and use Connections from the community."
      actions={
        <>
          <Button
            variant="outline"
            onClick={handleInstallRegistry}
            disabled={isInstalling || !firstRegistry}
          >
            {firstRegistry?.icon && (
              <img src={firstRegistry.icon} alt="" className="size-4" />
            )}
            {isInstalling ? "Installing..." : "Install Registry"}
          </Button>
          <Button variant="outline" onClick={handleInstallMcpServer}>
            Custom Connection
          </Button>
        </>
      }
    />
  );
}
