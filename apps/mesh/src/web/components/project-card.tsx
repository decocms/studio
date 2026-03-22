import { Link } from "@tanstack/react-router";
import { Settings, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useProjectContext } from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { AgentAvatar, getIconColor } from "@/web/components/agent-icon";
import { cn } from "@deco/ui/lib/utils.ts";

interface ProjectCardProps {
  project: VirtualMCPEntity;
  onSettingsClick?: (e: React.MouseEvent) => void;
  onDeleteClick?: (e: React.MouseEvent) => void;
}

export function ProjectCard({
  project,
  onSettingsClick,
  onDeleteClick,
}: ProjectCardProps) {
  const { org } = useProjectContext();

  const ui = project.metadata?.ui;
  const themeColor = ui?.themeColor as string | null | undefined;
  const iconColor = themeColor ? getIconColor(themeColor) : null;

  const bannerBg = iconColor?.bg ?? "bg-muted";

  return (
    <Link
      to="/$org/projects/$virtualMcpId"
      params={{ org: org.slug, virtualMcpId: project.id }}
      className="block group"
    >
      <div className="border border-border rounded-xl overflow-hidden bg-card">
        {/* Banner */}
        <div
          className={cn("h-20 relative", bannerBg)}
          style={
            ui?.banner
              ? {
                  backgroundImage: `url(${ui.banner})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }
              : undefined
          }
        >
          {/* Action Buttons */}
          <div className="absolute top-3 right-3 flex items-center gap-1">
            {onDeleteClick && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDeleteClick(e);
                }}
                className={cn(
                  "size-6 rounded-md flex items-center justify-center",
                  "bg-black/20 hover:bg-red-500/80 transition-colors",
                )}
              >
                <Trash2 className="size-3.5 text-white" />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSettingsClick?.(e);
              }}
              className={cn(
                "size-6 rounded-md flex items-center justify-center",
                "bg-black/20 hover:bg-black/40 transition-colors",
              )}
            >
              <Settings className="size-3.5 text-white" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex flex-col flex-1 justify-between p-4">
          {/* Top Section */}
          <div className="flex flex-col gap-4">
            {/* Project Icon */}
            <AgentAvatar
              icon={project.icon}
              name={project.title}
              size="md"
              className="shrink-0"
            />

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
              <AgentAvatar
                icon={org.logo ?? null}
                name={org.name}
                size="xs"
                className="shrink-0"
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
