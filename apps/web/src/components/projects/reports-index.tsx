/** Reports, at org scope: pick the project whose report you want.
 *
 *  A report describes ONE storefront, so the org-wide destination has nothing
 *  of its own to show — its whole job is to route you into a project. It is a
 *  chooser, not a dashboard: search, every project, and the way to make one
 *  that does not exist yet. Every project is listed — a diagnostic runs against
 *  a URL and the empty state asks for one, so there is no project that cannot
 *  have a report. Built on the DS `Command`: typing filters, Enter navigates. */

import { useNavigate } from "@tanstack/react-router";
import { BarChartSquare02, Plus } from "@untitledui/icons";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import { AgentAvatar, AgentAvatarPlaceholder } from "@/components/agent-icon";
import { Page } from "@/components/page";
import { openNewProjectDialog } from "@/components/projects/new-project-store";
import { ProjectsEmptyState } from "@/components/projects/projects-empty-state";
import { useCapability } from "@/hooks/use-capability";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { scopableProjects } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { useProjectContext, useVirtualMCPs } from "@/sdk";

export function ReportsIndex() {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { granted: canManageProjects } = useCapability("agents:manage");
  const all = useVirtualMCPs({ pageSize: 1000 });
  const projects = scopableProjects(all)
    .filter((p) => p.id !== org.id)
    .sort((a, b) => a.title.localeCompare(b.title));

  if (projects.length === 0) {
    return (
      <Page>
        <Page.Content>
          <Page.Container width="reading">
            <ProjectsEmptyState canCreate={canManageProjects} />
          </Page.Container>
        </Page.Content>
      </Page>
    );
  }

  return (
    <Page>
      <Page.Content>
        <div className="flex min-h-full w-full justify-center px-6 py-16">
          <div className="flex w-full max-w-sm flex-col items-center">
            <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground">
              <BarChartSquare02 width={20} height={20} aria-hidden />
            </span>

            <h1 className="mt-5 text-xl font-medium tracking-tight text-foreground">
              {t("projects.reports.chooserTitle")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("projects.reports.chooserSubtitle")}
            </p>

            {/* `bg-transparent`: the chooser sits on the page, not on a popover
                surface, and the list rows supply their own hover. */}
            <Command className="mt-8 w-full gap-3 bg-transparent">
              <CommandInput
                variant="boxed"
                autoFocus
                placeholder={t("projects.reports.chooserSearch")}
              />
              <CommandList className="max-h-80">
                <CommandEmpty>
                  {t("projects.reports.chooserEmpty")}
                </CommandEmpty>
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    size="lg"
                    value={project.title}
                    onSelect={() => {
                      track("reports_project_chosen");
                      navigate({
                        to: PROJECT_ROUTE.reports,
                        params: { org: org.slug, agentId: project.id },
                      });
                    }}
                  >
                    <AgentAvatar
                      icon={project.icon}
                      name={project.title}
                      size="sm"
                    />
                    <span className="truncate">{project.title}</span>
                  </CommandItem>
                ))}
                {canManageProjects && (
                  <CommandItem
                    size="lg"
                    value={t("projects.home.newProject")}
                    onSelect={() => openNewProjectDialog("reports_chooser")}
                  >
                    <AgentAvatarPlaceholder Icon={Plus} size="sm" />
                    <span>{t("projects.home.newProject")}</span>
                  </CommandItem>
                )}
              </CommandList>
            </Command>
          </div>
        </div>
      </Page.Content>
    </Page>
  );
}
