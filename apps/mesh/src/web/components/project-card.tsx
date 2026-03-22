import { Link } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useProjectContext } from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";

interface ProjectCardProps {
  project: VirtualMCPEntity;
  onSettingsClick?: (e: React.MouseEvent) => void;
}

export function ProjectCard({ project, onSettingsClick }: ProjectCardProps) {
  const { org } = useProjectContext();

  const ui = project.metadata?.ui;
  const themeColor = ui?.themeColor ?? "#60a5fa";

  const bannerStyle = {
    backgroundColor: ui?.bannerColor ?? themeColor,
    backgroundImage: ui?.banner ? `url(${ui.banner})` : undefined,
    backgroundSize: "cover",
    backgroundPosition: "center",
  };

  return (
    <Link
      to="/$org/projects/$virtualMcpId"
      params={{ org: org.slug, virtualMcpId: project.id }}
      className="block group"
    >
      <div className="border border-border rounded-xl overflow-hidden bg-card">
        {/* Banner */}
        <div className="h-20 relative" style={bannerStyle}>
          {/* Settings Button */}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSettingsClick?.(e);
            }}
            className={cn(
              "absolute top-3 right-3 size-6 rounded-md flex items-center justify-center",
              "bg-black/20 hover:bg-black/40 transition-colors",
            )}
          >
            <Settings className="size-3.5 text-white" />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-col flex-1 justify-between p-4">
          {/* Top Section */}
          <div className="flex flex-col gap-4">
            {/* Project Icon */}
            {ui?.icon ? (
              <img
                src={ui.icon}
                alt=""
                className="size-8 rounded-md object-cover"
              />
            ) : (
              <div
                className="size-8 rounded-md flex items-center justify-center"
                style={{ backgroundColor: themeColor }}
              >
                <span className="text-sm font-medium text-white">
                  {project.title.charAt(0).toUpperCase()}
                </span>
              </div>
            )}

            {/* Name & Time */}
            <div className="flex flex-col">
              <h3 className="font-medium text-base text-foreground truncate">
                {project.title}
              </h3>
              <p className="text-sm text-muted-foreground">
                Edited{" "}
                {formatDistanceToNow(new Date(project.updated_at), {
                  addSuffix: true,
                })}
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between mt-4">
            {/* Bound Connection Icons */}
            <div className="flex pr-2">
              {project.connections.slice(0, 4).map((conn) => (
                <div
                  key={conn.connection_id}
                  className="-mr-2 rounded-md border border-background"
                >
                  <ConnectionIcon connectionId={conn.connection_id} />
                </div>
              ))}
              {project.connections.length > 4 && (
                <div className="-mr-2 rounded-md border border-background">
                  <div className="size-6 rounded-md bg-background border border-black/10 shadow-sm flex items-center justify-center text-xs text-muted-foreground">
                    +{project.connections.length - 4}
                  </div>
                </div>
              )}
            </div>

            {/* Org Badge */}
            <div className="flex items-center gap-2 text-xs text-foreground">
              <Avatar
                url={org.logo ?? undefined}
                fallback={org.name}
                size="2xs"
                className="shrink-0 rounded"
                objectFit="cover"
              />
              <span className="truncate max-w-20">{org.name}</span>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

function ConnectionIcon({ connectionId }: { connectionId: string }) {
  const baseClasses =
    "size-6 rounded-md bg-background border border-black/10 shadow-sm flex items-center justify-center overflow-hidden";

  return (
    <div className={baseClasses} title={connectionId}>
      <span className="text-[10px] text-muted-foreground font-medium">
        {connectionId.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}
