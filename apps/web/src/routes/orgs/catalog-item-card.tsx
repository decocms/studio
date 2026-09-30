import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Container } from "@untitledui/icons";
import { getGitHubAvatarUrl } from "@/utils/github.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { ConnectionCard } from "@/components/connections/connection-card.tsx";
import type { ConnectionEntity } from "@/sdk";
import type { RegistryItem } from "@/components/store/types";
import { getRegistryItemAppName } from "@/utils/extract-connection-data";
import { useT } from "@/i18n/use-t.ts";
import { getStudioMcpMetadata } from "@decocms/shared/registry/metadata";

export function CatalogItemCard({
  item,
  canManage,
  allConnections,
  connectedAppNames,
  connectingItemId,
  onNavigateConnected,
  onConnect,
}: {
  item: RegistryItem;
  canManage: boolean;
  allConnections: ConnectionEntity[];
  connectedAppNames: Set<string>;
  connectingItemId: string | null;
  onNavigateConnected: (conn: ConnectionEntity) => void;
  onConnect: (item: RegistryItem) => void;
}) {
  const t = useT();

  const appName = getRegistryItemAppName(item) ?? "";
  const isConnected = connectedAppNames.has(appName);
  const studioMeta = getStudioMcpMetadata(item._meta);
  const title =
    studioMeta?.friendlyName ||
    studioMeta?.friendly_name ||
    item.server?.title ||
    item.title ||
    item.server?.name ||
    item.name ||
    item.id ||
    "";
  const description = item.server?.description || item.description || null;
  const icon =
    item.server?.icons?.[0]?.src ||
    getGitHubAvatarUrl(item.server?.repository) ||
    null;
  const appInstances = allConnections.filter(
    (c) => c.connection_type !== "VIRTUAL" && c.app_name === appName,
  );

  // Members without connections:manage can browse but not connect.
  const isClickable = isConnected || canManage;

  const handleClick = () => {
    if (isConnected) {
      const first = appInstances[0];
      if (first) {
        onNavigateConnected(first);
      }
      return;
    }
    handleConnect();
  };

  const handleConnect = () => onConnect(item);

  return (
    <ConnectionCard
      connection={{ title, description, icon }}
      fallbackIcon={<Container />}
      onClick={isClickable ? handleClick : undefined}
      headerActionsAlwaysVisible
      headerActions={
        <div className="flex items-center gap-2">
          {isConnected ? (
            <span className="text-xs text-muted-foreground font-normal">
              {t("orgs.catalogItemCard.connected")}
            </span>
          ) : (
            canManage && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-3 text-sm font-medium"
                disabled={connectingItemId !== null}
                onClick={(e) => {
                  e.stopPropagation();
                  handleConnect();
                }}
              >
                {connectingItemId === item.id ? (
                  <Spinner className="size-3.5" />
                ) : (
                  t("orgs.catalogItemCard.connect")
                )}
              </Button>
            )
          )}
        </div>
      }
    />
  );
}
