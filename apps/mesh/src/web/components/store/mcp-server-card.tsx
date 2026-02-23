import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  CheckVerified02,
  Lock01,
  Plus,
  Globe02,
  Server01,
  Terminal,
} from "@untitledui/icons";
import { Card } from "@deco/ui/components/card.js";
import { cn } from "@deco/ui/lib/utils.ts";
import { IntegrationIcon } from "../integration-icon.tsx";
import { getGitHubAvatarUrl } from "@/web/utils/github";
import { extractDisplayNameFromDomain } from "@/web/utils/server-name";
import type { RegistryItem, Protocol } from "./types";

// Re-export types for backwards compatibility
export type {
  MCPRegistryServer,
  MCPRegistryServerIcon,
  MCPRegistryServerMeta,
  RegistryItem,
} from "./types";

// ============================================================================
// Protocol Badge Component
// ============================================================================

interface ProtocolBadgeProps {
  protocol: Protocol;
}

function ProtocolIcon({
  protocol,
  className,
}: {
  protocol: Protocol;
  className?: string;
}) {
  const icons: Record<Protocol, React.ReactNode> = {
    http: <Globe02 className={className} />,
    sse: <Server01 className={className} />,
    stdio: <Terminal className={className} />,
  };
  return icons[protocol];
}

function getProtocolLabel(protocol: Protocol): string {
  switch (protocol) {
    case "http":
      return "HTTP";
    case "sse":
      return "SSE";
    case "stdio":
      return "STDIO";
  }
}

/** Badge showing protocol type with icon and color */
function ProtocolBadge({ protocol }: ProtocolBadgeProps) {
  const colorClasses: Record<Protocol, string> = {
    http: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    sse: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    stdio:
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium shrink-0",
        colorClasses[protocol],
      )}
    >
      <ProtocolIcon protocol={protocol} className="w-3 h-3" />
      {getProtocolLabel(protocol)}
    </div>
  );
}

// ============================================================================
// Card Props & Types
// ============================================================================

interface MCPServerCardBaseProps {
  icon: string | null;
  displayName: string;
  description: string | null;
  onClick: () => void;
}

interface MCPServerCardStoreProps extends MCPServerCardBaseProps {
  variant?: "store";
  scopeName: string | null;
  isVerified: boolean;
  canInstall: boolean;
}

interface MCPServerCardServerProps extends MCPServerCardBaseProps {
  variant: "server";
  hostname: string;
  protocol: Protocol;
  isInstalling?: boolean;
  actionLabel?: string;
}

export type MCPServerCardProps =
  | MCPServerCardStoreProps
  | MCPServerCardServerProps;

// ============================================================================
// Main Card Component
// ============================================================================

/**
 * Unified card component for displaying MCP Servers
 * - variant="store": Used in the main store grid (default)
 * - variant="server": Used in the server/remote selection list
 */
export function MCPServerCard(props: MCPServerCardProps) {
  const { icon, displayName, description, onClick } = props;
  const variant = props.variant ?? "store";
  const isServer = variant === "server";

  // Server variant specific props
  const hostname = isServer
    ? (props as MCPServerCardServerProps).hostname
    : null;
  const protocol = isServer
    ? (props as MCPServerCardServerProps).protocol
    : null;
  const isInstalling = isServer
    ? (props as MCPServerCardServerProps).isInstalling
    : false;
  const actionLabel = isServer
    ? (props as MCPServerCardServerProps).actionLabel
    : undefined;

  // Store variant specific props
  const scopeName = !isServer
    ? (props as MCPServerCardStoreProps).scopeName
    : null;
  const isVerified = !isServer
    ? (props as MCPServerCardStoreProps).isVerified
    : false;
  const canInstall = !isServer
    ? (props as MCPServerCardStoreProps).canInstall
    : true;

  return (
    <Card
      className={cn(
        "cursor-pointer hover:bg-muted/50 transition-colors",
        isServer ? "p-4" : "p-6",
      )}
      onClick={onClick}
    >
      <div
        className={cn(
          "flex flex-col h-full relative",
          isServer ? "gap-3" : "gap-4",
        )}
      >
        {/* Header */}
        <div className="flex gap-3">
          <IntegrationIcon
            icon={icon}
            name={displayName}
            size={isServer ? "sm" : "md"}
            className="shadow-sm shrink-0"
          />

          <div className="flex gap-2 items-start min-w-0 flex-1">
            <div className="min-w-0 flex-1">
              {/* Title row */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      "flex items-center gap-2 font-medium min-w-0",
                      isServer ? "text-sm" : "text-base",
                    )}
                  >
                    <span className="truncate">{displayName}</span>

                    {/* Store variant badges */}
                    {!isServer && isVerified && (
                      <CheckVerified02
                        size={16}
                        className="text-success shrink-0"
                      />
                    )}
                    {!isServer && !canInstall && (
                      <Lock01
                        size={16}
                        className="text-muted-foreground shrink-0"
                      />
                    )}

                    {/* Server variant badge */}
                    {isServer && protocol && (
                      <ProtocolBadge protocol={protocol} />
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{displayName}</p>
                  {!isServer && !canInstall && (
                    <p className="text-xs mt-1">No connection available</p>
                  )}
                </TooltipContent>
              </Tooltip>

              {/* Subtitle */}
              {(scopeName || hostname) && (
                <div
                  className={cn(
                    "text-muted-foreground truncate",
                    isServer ? "text-xs mt-0.5" : "text-sm",
                  )}
                >
                  {scopeName || hostname}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Description */}
        {description && (
          <div className="text-sm text-muted-foreground line-clamp-2">
            {description}
          </div>
        )}
        {!description && !isServer && (
          <div className="text-sm text-muted-foreground line-clamp-2">
            No description available
          </div>
        )}

        {/* Action button (server variant only) */}
        {isServer && (
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
            disabled={isInstalling}
            className="w-full mt-auto cursor-pointer"
          >
            <Plus size={16} />
            {isInstalling ? "Connecting..." : actionLabel || "Connect"}
          </Button>
        )}
      </div>
    </Card>
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract display data from a registry item for the card component
 * Handles name parsing, icon extraction, and verification status
 */
function extractCardDisplayData(
  item: RegistryItem,
): Omit<MCPServerCardStoreProps, "onClick" | "variant"> {
  const server = item.server;
  const meshMeta = item._meta?.["mcp.mesh"];
  const rawTitle =
    meshMeta?.friendly_name ||
    item.name ||
    server?.title ||
    item.title ||
    item.id ||
    "Unnamed Item";

  // Description priority: short_description > mesh_description > server.description > item.description
  const description =
    meshMeta?.short_description ||
    meshMeta?.mesh_description ||
    server?.description ||
    item.description ||
    null;

  const icon =
    server?.icons?.[0]?.src || getGitHubAvatarUrl(server?.repository) || null;
  const isVerified = meshMeta?.verified ?? false;
  const hasRemotes = (server?.remotes?.length ?? 0) > 0;
  const hasPackages = (server?.packages?.length ?? 0) > 0;
  const canInstall = hasRemotes || hasPackages;

  // Extract scopeName and displayName from title if it contains "/"
  let displayName = rawTitle;
  let scopeName: string | null = null;

  if (rawTitle.includes("/")) {
    const parts = rawTitle.split("/");
    if (parts.length >= 2) {
      scopeName = parts[0] || null;
      // Use function to extract the correct name
      displayName = extractDisplayNameFromDomain(rawTitle);
    }
  }

  // Fallback to _meta if scopeName wasn't extracted from title
  if (!scopeName) {
    const metaScopeName = meshMeta?.scopeName;
    const metaAppName = meshMeta?.appName;
    if (metaScopeName && metaAppName) {
      scopeName = `${metaScopeName}/${metaAppName}`;
    } else if (metaScopeName) {
      scopeName = metaScopeName;
    }
  }

  // Fallback to item.id when it contains a scope (e.g. "provider/name")
  if (!scopeName && item.id.includes("/")) {
    scopeName = item.id;
  }

  // PRIORITY: Use friendly_name if available, otherwise use displayName
  if (meshMeta?.friendly_name) {
    displayName = meshMeta.friendly_name;
  }

  return {
    icon,
    scopeName,
    displayName,
    description,
    isVerified,
    canInstall,
  };
}

// ============================================================================
// Grid Component
// ============================================================================

interface MCPServerCardGridProps {
  items: RegistryItem[];
  title: string;
  subtitle?: string;
  onItemClick: (item: RegistryItem) => void;
  totalCount?: number | null;
}

/**
 * Grid component for displaying multiple MCP Server cards
 */
export function MCPServerCardGrid({
  items,
  title,
  onItemClick,
}: MCPServerCardGridProps) {
  const safeItems = items.filter((item) => item !== null && item !== undefined);
  if (safeItems.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {title && (
        <div className="flex items-center justify-between w-max gap-2">
          <h2 className="text-lg font-medium">{title}</h2>
        </div>
      )}
      <div className="grid grid-cols-4 gap-4">
        {safeItems.map((item) => {
          const displayData = extractCardDisplayData(item);
          return (
            <MCPServerCard
              key={item.id}
              {...displayData}
              onClick={() => onItemClick(item)}
            />
          );
        })}
      </div>
    </div>
  );
}
