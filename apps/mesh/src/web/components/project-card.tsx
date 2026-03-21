import { Link } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type {
  ProjectUI,
  BoundConnectionSummary,
} from "@/web/hooks/use-project";

interface ProjectCardProps {
  project: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    boundConnections: BoundConnectionSummary[];
    ui: ProjectUI | null;
    updatedAt: string;
  };
  onSettingsClick?: (e: React.MouseEvent) => void;
}

export function ProjectCard({ project, onSettingsClick }: ProjectCardProps) {
  const { org } = useProjectContext();

  const themeColor = project.ui?.themeColor ?? "#60a5fa";

  const bannerStyle = {
    backgroundColor: project.ui?.bannerColor ?? themeColor,
    backgroundImage: project.ui?.banner
      ? `url(${project.ui.banner})`
      : undefined,
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
            {project.ui?.icon ? (
              <img
                src={project.ui.icon}
                alt=""
                className="size-8 rounded-md object-cover"
              />
            ) : (
              <div
                className="size-8 rounded-md flex items-center justify-center"
                style={{ backgroundColor: themeColor }}
              >
                <span className="text-sm font-medium text-white">
                  {project.name.charAt(0).toUpperCase()}
                </span>
              </div>
            )}

            {/* Name & Time */}
            <div className="flex flex-col">
              <h3 className="font-medium text-base text-foreground truncate">
                {project.name}
              </h3>
              <p className="text-sm text-muted-foreground">
                Edited{" "}
                {formatDistanceToNow(new Date(project.updatedAt), {
                  addSuffix: true,
                })}
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between mt-4">
            {/* Bound Connection Icons */}
            <div className="flex pr-2">
              {project.boundConnections.slice(0, 4).map((conn) => (
                <div
                  key={conn.id}
                  className="-mr-2 rounded-md border border-background"
                >
                  <ConnectionIcon connection={conn} />
                </div>
              ))}
              {project.boundConnections.length > 4 && (
                <div className="-mr-2 rounded-md border border-background">
                  <div className="size-6 rounded-md bg-background border border-black/10 shadow-sm flex items-center justify-center text-xs text-muted-foreground">
                    +{project.boundConnections.length - 4}
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

function ConnectionIcon({
  connection,
}: {
  connection: BoundConnectionSummary;
}) {
  const baseClasses =
    "size-6 rounded-md bg-background border border-black/10 shadow-sm flex items-center justify-center overflow-hidden";

  if (connection.icon) {
    return (
      <div className={baseClasses} title={connection.title}>
        <img
          src={connection.icon}
          alt={connection.title}
          className="size-4 object-cover"
        />
      </div>
    );
  }

  return (
    <div className={baseClasses} title={connection.title}>
      <span className="text-[10px] text-muted-foreground font-medium">
        {connection.title.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}
