import { DropdownMenuItem } from "@deco/ui/components/dropdown-menu.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Check } from "@untitledui/icons";
import { useProjects } from "@/web/hooks/use-projects";

export function ProjectListSkeleton() {
  return (
    <div className="space-y-0.5 px-1 py-1">
      <Skeleton className="h-8 w-full rounded-lg" />
      <Skeleton className="h-8 w-full rounded-lg" />
    </div>
  );
}

interface UserProjectItemsProps {
  currentProjectId?: string;
  orgSlug: string;
  onSelect: (virtualMcpId: string) => void;
  onSettings?: (virtualMcpId: string) => void;
}

export function UserProjectItems({
  currentProjectId,
  onSelect,
}: UserProjectItemsProps) {
  const projects = useProjects();

  if (projects.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-xs text-muted-foreground">
        No projects yet
      </div>
    );
  }

  return (
    <>
      {projects.map((project) => {
        const isActive = currentProjectId === project.id;
        const ui = project.metadata?.ui;
        const themeColor = ui?.themeColor ?? "#3B82F6";

        return (
          <DropdownMenuItem
            key={project.id}
            className={cn("gap-2.5", isActive && "bg-accent")}
            onClick={() => onSelect(project.id)}
          >
            <div
              className="size-6 rounded-md shrink-0 flex items-center justify-center overflow-hidden border border-border/50"
              style={ui?.icon ? undefined : { backgroundColor: themeColor }}
            >
              {ui?.icon ? (
                <img src={ui.icon} alt="" className="size-full object-cover" />
              ) : (
                <span className="text-xs font-semibold text-white">
                  {project.title.charAt(0).toUpperCase()}
                </span>
              )}
            </div>
            <span className="flex-1 truncate">{project.title}</span>
            {isActive && (
              <Check
                size={14}
                className="ml-auto text-muted-foreground shrink-0"
              />
            )}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
