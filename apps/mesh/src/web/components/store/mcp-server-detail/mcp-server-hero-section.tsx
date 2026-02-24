import type { RegistryItem } from "@/web/components/store/types";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Plus, ChevronDown, CheckCircle } from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { useState } from "react";
import type { MCPServerData } from "./types";

// ============================================================================
// Version Dropdown Component
// ============================================================================

interface VersionDropdownProps {
  versions: RegistryItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  isInstalling?: boolean;
  variant?: "default" | "outline";
  showLabel?: boolean;
}

function VersionDropdown({
  versions,
  selectedIndex,
  onSelect,
  isInstalling = false,
  variant = "default",
  showLabel = false,
}: VersionDropdownProps) {
  const selectedVersion = versions[selectedIndex];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant}
          disabled={isInstalling}
          size={showLabel ? "sm" : "default"}
          className={cn(
            "shrink-0 cursor-pointer",
            variant === "default" &&
              "rounded-l-none px-2 border-l-2 border-l-white/50",
          )}
        >
          {showLabel && (
            <span className="mr-1">
              v{selectedVersion?.server?.version || "unknown"}
            </span>
          )}
          <ChevronDown size={showLabel ? 14 : 20} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56 max-h-[300px] overflow-y-auto"
      >
        {versions.map((version, index) => {
          const versionMeta = version._meta?.[
            "io.modelcontextprotocol.registry/official"
          ] as { isLatest?: boolean } | undefined;

          return (
            <DropdownMenuItem
              key={index}
              onClick={() => onSelect(index)}
              disabled={isInstalling}
              className="cursor-pointer"
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <div className="flex items-center gap-2">
                  <div className="font-medium text-sm">
                    v{version.server?.version || "unknown"}
                  </div>
                  {versionMeta?.isLatest && (
                    <div className="text-xs text-muted-foreground/50 font-semibold">
                      LATEST
                    </div>
                  )}
                </div>
                {index === selectedIndex && (
                  <CheckCircle
                    size={16}
                    className="text-muted-foreground shrink-0"
                  />
                )}
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ============================================================================
// Main Component
// ============================================================================

interface MCPServerHeroSectionProps {
  data: MCPServerData;
  itemVersions: RegistryItem[];
  onInstall: (
    versionIndex?: number,
    remoteIndex?: number,
    packageIndex?: number,
  ) => void;
  isInstalling?: boolean;
  canInstall?: boolean;
  /** Hide install controls (when showing servers list tab instead) */
  hideInstallControls?: boolean;
  /** Selected version index (controlled from parent when hideInstallControls is true) */
  selectedVersionIndex?: number;
  /** Callback when version selection changes */
  onVersionChange?: (index: number) => void;
}

export function MCPServerHeroSection({
  data,
  itemVersions,
  onInstall,
  canInstall = true,
  isInstalling = false,
  hideInstallControls = false,
  selectedVersionIndex: controlledVersionIndex,
  onVersionChange,
}: MCPServerHeroSectionProps) {
  // Use controlled version index when provided (for hideInstallControls mode)
  const [internalVersionIndex, setInternalVersionIndex] = useState<number>(0);
  const selectedVersionIndex = controlledVersionIndex ?? internalVersionIndex;
  const setSelectedVersionIndex = (index: number) => {
    setInternalVersionIndex(index);
    onVersionChange?.(index);
  };

  const selectedVersion = itemVersions[selectedVersionIndex] || itemVersions[0];
  const remotes = selectedVersion?.server?.remotes ?? [];
  const packages = selectedVersion?.server?.packages ?? [];
  const hasPackages = packages.length > 0;
  const hasRemotes = remotes.length > 0;

  // When showing single server Connect button, use first available option
  // Prefer HTTP remotes, then any remote, then packages
  const defaultRemoteIndex = (() => {
    const httpIndex = remotes.findIndex(
      (r) =>
        r.type?.toLowerCase() === "http" ||
        r.type?.toLowerCase() === "streamable-http",
    );
    return httpIndex >= 0 ? httpIndex : 0;
  })();

  const handleInstall = () => {
    if (hasRemotes) {
      onInstall(selectedVersionIndex, defaultRemoteIndex, undefined);
    } else if (hasPackages) {
      onInstall(selectedVersionIndex, undefined, 0);
    }
  };

  const handleInstallVersion = (versionIndex: number) => {
    setSelectedVersionIndex(versionIndex);
    // Install using default options for the target version
    const targetVersion = itemVersions[versionIndex];
    const targetRemotes = targetVersion?.server?.remotes ?? [];
    const targetPackages = targetVersion?.server?.packages ?? [];
    const targetHasRemotes = targetRemotes.length > 0;

    if (targetHasRemotes) {
      // Prefer HTTP remote
      const httpIndex = targetRemotes.findIndex(
        (r) =>
          r.type?.toLowerCase() === "http" ||
          r.type?.toLowerCase() === "streamable-http",
      );
      onInstall(versionIndex, httpIndex >= 0 ? httpIndex : 0, undefined);
    } else if (targetPackages.length > 0) {
      onInstall(versionIndex, undefined, 0);
    }
  };

  return (
    <div className="flex items-center gap-4 py-8 px-5 border-b border-border">
      {/* Server Icon */}
      <IntegrationIcon
        icon={data.icon}
        name={data.name}
        size="lg"
        className="shrink-0 shadow-sm"
      />

      {/* Server Info */}
      <div className="flex-1 min-w-0 flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-medium">{data.name}</h1>
            {data.verified && (
              <img
                src="/verified-badge.svg"
                alt="Verified"
                className="w-5 h-5 shrink-0"
              />
            )}
          </div>
          {data.shortDescription && (
            <p className="text-sm text-muted-foreground mt-1">
              {data.shortDescription}
            </p>
          )}
        </div>

        {/* Install Controls */}
        {canInstall && !hideInstallControls ? (
          <div className="shrink-0 flex items-center gap-2">
            {/* Connect Button - with version selector if multiple versions */}
            {itemVersions.length > 1 ? (
              <div className="flex">
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleInstall}
                  disabled={isInstalling}
                  className="shrink-0 rounded-r-none cursor-pointer"
                >
                  <Plus size={20} />
                  {isInstalling ? "Connecting..." : "Connect"}
                </Button>

                <VersionDropdown
                  versions={itemVersions}
                  selectedIndex={selectedVersionIndex}
                  onSelect={handleInstallVersion}
                  isInstalling={isInstalling}
                  variant="outline"
                />
              </div>
            ) : (
              <Button
                variant="default"
                size="sm"
                onClick={handleInstall}
                disabled={itemVersions.length === 0 || isInstalling}
                className="shrink-0 cursor-pointer"
              >
                <Plus size={20} />
                {isInstalling ? "Connecting..." : "Connect"}
              </Button>
            )}
          </div>
        ) : !hideInstallControls ? (
          <div className="shrink-0 px-4 py-2 text-sm text-muted-foreground bg-muted rounded-lg">
            Cannot be connected
          </div>
        ) : itemVersions.length > 1 ? (
          // Show standalone version selector when install controls are hidden but multiple versions exist
          <div className="shrink-0">
            <VersionDropdown
              versions={itemVersions}
              selectedIndex={selectedVersionIndex}
              onSelect={setSelectedVersionIndex}
              isInstalling={isInstalling}
              variant="outline"
              showLabel
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
