/**
 * Settings › Projects — the org's projects, and the boundary between what is
 * configured once for the organization and what is configured per project.
 *
 * The settings tree used to have exactly one axis: the organization. That was
 * fine while a project was a repository someone had imported, and stops being
 * fine the moment an org runs a storefront, an app and three seller accounts
 * off different platforms and different analytics accounts. So this page is the
 * index INTO the per-project settings: each row says what the project is, what
 * it is built from, and where its report stands, and opens that project's own
 * settings.
 *
 * The note under the heading is load-bearing, not decoration: members, billing,
 * security and AI providers are deliberately NOT per project, and saying so
 * here is cheaper than letting someone hunt for them inside a project.
 */

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { GitBranch01, ZapSquare } from "@untitledui/icons";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { AgentAvatar } from "@/components/agent-icon";
import { Page } from "@/components/page";
import { NewProjectButton } from "@/components/projects/new-project-dialog";
import { PlatformMark } from "@/components/projects/platform-mark";
import { ProjectsEmptyState } from "@/components/projects/projects-empty-state";
import { useCapability } from "@/hooks/use-capability";
import { useDateFnsLocale } from "@/hooks/use-date-fns-locale.ts";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useProjectReports } from "@/hooks/use-project-reports";
import { scopableProjects } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { projectRepo } from "@/lib/github-repo";
import {
  readProjectProfile,
  storeHost,
  type CommercePlatform,
} from "@/lib/project-profile.ts";
import { useProjectPlatforms } from "@/hooks/use-project-platform";
import type { ProjectReportStatus } from "@/hooks/use-project-reports";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useProjectContext, useVirtualMCPs } from "@/sdk";

const REPORT_LABEL: Record<ProjectReportStatus, TranslationKey> = {
  ready: "projects.reports.status.ready",
  running: "projects.reports.status.running",
  locked: "projects.reports.status.locked",
  none: "projects.reports.status.none",
};

function ProjectRow({
  project,
  orgSlug,
  reportStatus,
  platform,
}: {
  project: VirtualMCPEntity;
  orgSlug: string;
  reportStatus: ProjectReportStatus;
  platform: CommercePlatform | null;
}) {
  const t = useT();
  const locale = useDateFnsLocale();
  const profile = readProjectProfile(project);
  const repo = projectRepo(project);
  const host = storeHost(profile.storeUrl);
  const connections = project.connections?.length ?? 0;

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl bg-card p-4 card-shadow">
      <AgentAvatar icon={project.icon} name={project.title} size="sm" />
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">
          {project.title}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {host ??
            repo ??
            t("projects.card.updated", {
              time: formatDistanceToNow(new Date(project.updated_at), {
                addSuffix: true,
                locale,
              }),
            })}
        </span>
      </div>

      {platform && <PlatformMark platform={platform} size="sm" />}

      <div className="hidden items-center gap-3 text-xs text-muted-foreground md:flex">
        {repo && (
          <span className="inline-flex items-center gap-1">
            <GitBranch01 width={12} height={12} aria-hidden />
            {repo}
          </span>
        )}
        {connections > 0 && (
          <span className="inline-flex items-center gap-1">
            <ZapSquare width={12} height={12} aria-hidden />
            {connections}
          </span>
        )}
      </div>

      <Badge variant={reportStatus === "ready" ? "success" : "muted"}>
        {t(REPORT_LABEL[reportStatus])}
      </Badge>

      <div className="flex items-center gap-1">
        <Button asChild variant="ghost" size="sm">
          <Link
            to={PROJECT_ROUTE.root}
            params={{ org: orgSlug, agentId: project.id }}
          >
            {t("projects.settings.open")}
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link
            to={PROJECT_ROUTE.settings}
            params={{ org: orgSlug, agentId: project.id }}
          >
            {t("projects.settings.openSettings")}
          </Link>
        </Button>
      </div>
    </li>
  );
}

export default function SettingsProjectsPage() {
  const t = useT();
  const { org } = useProjectContext();
  const [search, setSearch] = useState("");
  const { granted: canManageProjects } = useCapability("agents:manage");
  const all = useVirtualMCPs({ pageSize: 1000 });
  const projects = scopableProjects(all).filter((p) => p.id !== org.id);
  const { byProject } = useProjectReports(projects);
  const platforms = useProjectPlatforms(projects);

  const term = search.trim().toLowerCase();
  const shown = term
    ? projects.filter((project) =>
        `${project.title} ${readProjectProfile(project).storeUrl ?? ""}`
          .toLowerCase()
          .includes(term),
      )
    : projects;

  return (
    <Page>
      <Page.Content>
        <Page.Container className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Page.Title
              actions={
                canManageProjects && (
                  <NewProjectButton source="settings_projects" />
                )
              }
            >
              {t("projects.settings.title")}
            </Page.Title>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("projects.settings.description")}{" "}
              {t("projects.settings.orgScopeNote")}
            </p>
          </div>

          {projects.length === 0 ? (
            <ProjectsEmptyState canCreate={canManageProjects} />
          ) : (
            <>
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t("projects.settings.searchPlaceholder")}
                className="w-full md:w-[375px]"
              />
              {shown.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {t("projects.settings.noResults", { search })}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {shown.map((project) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      orgSlug={org.slug}
                      reportStatus={byProject.get(project.id)?.status ?? "none"}
                      platform={platforms.get(project.id) ?? null}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
