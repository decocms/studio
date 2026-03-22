import { authClient } from "@/web/lib/auth-client";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useConnectionInstall,
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
  const connectionInstall = useConnectionInstall();
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
      const result = await connectionInstall.mutateAsync({
        title: firstRegistry.title,
        connection_url: firstRegistry.connection_url ?? "",
        description: firstRegistry.description ?? undefined,
        icon: firstRegistry.icon ?? undefined,
        app_name: firstRegistry.app_name ?? undefined,
        app_id: firstRegistry.app_id ?? undefined,
        connection_type:
          (firstRegistry.connection_type as "HTTP" | "SSE" | "Websocket") ??
          "HTTP",
        id: firstRegistry.id,
        connection_token: firstRegistry.connection_token ?? undefined,
        connection_headers:
          (firstRegistry.connection_headers as Record<string, unknown>) ??
          undefined,
        oauth_config:
          (firstRegistry.oauth_config as Record<string, unknown>) ?? undefined,
        configuration_state:
          (firstRegistry.configuration_state as Record<string, unknown>) ??
          undefined,
        configuration_scopes: firstRegistry.configuration_scopes ?? undefined,
        metadata:
          (firstRegistry.metadata as Record<string, unknown>) ?? undefined,
      });
      onConnected?.(result.connection_id);
    } finally {
      setIsInstalling(false);
    }
  };

  const handleInstallMcpServer = () => {
    navigate({
      to: "/$org/$project/mcps",
      params: { org: orgSlug, project: ORG_ADMIN_PROJECT_SLUG },
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
