/**
 * The sidebar's header inside a project, under the new navigation: the
 * project's name behind a back arrow, which leaves to the org. Switching
 * projects is the org's sidebar. Outside a project — or before the scoped one
 * resolves — it is the org label.
 */

import { ArrowLeft } from "@untitledui/icons";
import { useExitProjectScope } from "@/hooks/use-exit-project-scope";
import { useProjectScope } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { OrgLabel } from "./org-label";

export function ProjectSwitcher({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  /** Closes the mobile sheet, or the org you went back to stays behind it. */
  onNavigate?: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const { project } = useProjectScope();
  const exitToOrg = useExitProjectScope();

  if (!project) return <OrgLabel collapsed={collapsed} />;

  const back = t("sidebar.scope.backTo", { name: org.name });
  return (
    <button
      type="button"
      title={back}
      aria-label={back}
      onClick={() => {
        exitToOrg();
        onNavigate?.();
      }}
      /* Same box as `OrgLabel`, so swapping one for the other moves nothing. */
      className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pr-1.5 pl-2 text-left transition-colors hover:bg-sidebar-accent md:h-[34px] md:py-0"
    >
      <ArrowLeft size={16} className="shrink-0 text-muted-foreground" />
      {!collapsed && (
        <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
          {project.title}
        </span>
      )}
    </button>
  );
}
