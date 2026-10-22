/**
 * The sidebar's header inside a project, under the new navigation: which
 * project this is, and a list to jump to another one or back out to the org.
 * Outside a project — or before the scoped one resolves — it is the org label.
 */

import { Check, ChevronSelectorVertical } from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { ProjectIcon } from "@/components/project-icon";
import { useExitProjectScope } from "@/hooks/use-exit-project-scope";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { useProjectScope } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { OrgLabel } from "./org-label";

export function ProjectSwitcher({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  /** Closes the mobile sheet, or the project you picked stays behind it. */
  onNavigate?: () => void;
}) {
  const t = useT();
  const { project, projects } = useProjectScope();
  const navigateToAgent = useNavigateToAgent();
  const exitToOrg = useExitProjectScope();

  if (!project) return <OrgLabel collapsed={collapsed} />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={project.title}
          /* Same box as `OrgLabel`, so swapping one for the other moves nothing. */
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pr-1.5 pl-2 text-left transition-colors hover:bg-sidebar-accent md:h-[34px] md:py-0"
        >
          <ProjectIcon icon={project.icon} name={project.title} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
                {project.title}
              </span>
              <ChevronSelectorVertical
                size={14}
                className="shrink-0 text-muted-foreground"
              />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-96 w-64 overflow-y-auto"
      >
        {projects.map((other) => (
          <DropdownMenuItem
            key={other.id}
            className="gap-2"
            onSelect={() => {
              navigateToAgent(other.id);
              onNavigate?.();
            }}
          >
            <ProjectIcon icon={other.icon} name={other.title} />
            <span className="min-w-0 flex-1 truncate">{other.title}</span>
            {other.id === project.id && (
              <Check size={14} className="shrink-0 text-muted-foreground" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            exitToOrg();
            onNavigate?.();
          }}
        >
          {t("sidebar.scope.allProjects")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
