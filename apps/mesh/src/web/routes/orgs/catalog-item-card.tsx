import { useState } from "react";
import { Container, Loading01 } from "@untitledui/icons";
import { getGitHubAvatarUrl } from "@deco/ui/lib/github.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { ConnectionCard } from "@/web/components/connections/connection-card.tsx";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { track } from "@/web/lib/posthog-client";
import type { RegistryItem } from "@/web/components/store/types";
import { getRegistryItemAppName } from "@/web/utils/extract-connection-data";
import { useT } from "@/web/i18n/use-t.ts";

function isCommunityItem(item: RegistryItem): boolean {
  return item._registryId?.includes("community-registry") === true;
}

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
  const [communityWarningOpen, setCommunityWarningOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"connect" | null>(null);

  const appName = getRegistryItemAppName(item) ?? "";
  const isConnected = connectedAppNames.has(appName);
  const studioMeta = item._meta?.["mcp.mesh"] as
    | Record<string, string>
    | undefined;
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

  const isCommunity = isCommunityItem(item);

  const handleClick = () => {
    if (isConnected) {
      const first = appInstances[0];
      if (first) {
        onNavigateConnected(first);
      }
      return;
    }
    // Connecting installs a connection (connections:manage). Members without it
    // can browse the catalog but not connect.
    if (canManage) {
      handleConnect();
    }
  };

  const handleConnect = () => {
    if (isCommunity) {
      setPendingAction("connect");
      setCommunityWarningOpen(true);
    } else {
      onConnect(item);
    }
  };

  const handleCommunityConfirm = () => {
    track("connections_community_warning_confirmed", {
      registry_item_id: item.id,
    });
    setCommunityWarningOpen(false);
    if (pendingAction === "connect") {
      onConnect(item);
    }
    setPendingAction(null);
  };

  return (
    <>
      <ConnectionCard
        connection={{ title, description, icon }}
        fallbackIcon={<Container />}
        onClick={handleClick}
        headerActionsAlwaysVisible
        headerActions={
          <div className="flex items-center gap-2">
            {isCommunity && item._sourceIcon && (
              <img
                src={item._sourceIcon}
                alt="Community"
                className="size-4 rounded-sm object-contain"
              />
            )}
            {isConnected ? (
              <span className="text-xs text-muted-foreground font-normal">
                {t("orgs.catalogItemCard.connected")}
              </span>
            ) : (
              canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 rounded-lg text-sm font-medium"
                  disabled={connectingItemId !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleConnect();
                  }}
                >
                  {connectingItemId === item.id ? (
                    <Loading01 size={14} className="animate-spin" />
                  ) : (
                    t("orgs.catalogItemCard.connect")
                  )}
                </Button>
              )
            )}
          </div>
        }
      />
      <AlertDialog
        open={communityWarningOpen}
        onOpenChange={setCommunityWarningOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("orgs.catalogItemCard.communityMcpServerTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("orgs.catalogItemCard.communityMcpServerDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("orgs.catalogItemCard.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleCommunityConfirm}>
              {t("orgs.catalogItemCard.continue")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
