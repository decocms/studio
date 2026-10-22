/**
 * Context: what agents know, in one place. For the org, the Library's files
 * plus the brand, connections, repositories, skills and memory that used to
 * live in Settings; for a project, its folder plus what was its Settings.
 * Project-first nav only.
 */

import type { ComponentType, ReactNode } from "react";
import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import {
  BookOpen01,
  Folder,
  GitBranch01,
  Lightbulb02,
  MagicWand02,
  Stars01,
  ZapSquare,
} from "@untitledui/icons";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { PAGE_INSET, Page } from "@/components/page";
import { Panel } from "@/components/panel";
import { RequireCapability } from "@/components/require-capability";
import { SettingsPage } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import type { ContextSection } from "@/lib/legacy-workspace-search";
import type { ProjectContextSection } from "@/views/virtual-mcp";
import { PROJECT_SETTINGS_SECTIONS } from "@/views/virtual-mcp/settings/sections";
import { BrandOverview } from "./brand-overview";

const OrgMcps = lazy(() => import("@/routes/orgs/connections"));
const SkillsPage = lazy(() => import("@/routes/orgs/settings/skills"));
const MemoryPage = lazy(() => import("@/routes/orgs/settings/memory"));
const RepositoriesContent = lazy(() =>
  import("@/views/settings/repositories").then((m) => ({
    default: m.RepositoriesContent,
  })),
);

type Icon = ComponentType<{ size?: number; className?: string }>;

type OrgSection = Exclude<ContextSection, "instructions" | "general" | "site">;
type ProjectSection = "files" | ProjectContextSection;

/** The org's section in the URL; a project's sections fall back to the files. */
export function orgSection(section: ContextSection | undefined): OrgSection {
  return section === undefined ||
    section === "instructions" ||
    section === "general" ||
    section === "site"
    ? "files"
    : section;
}

/** The project's section in the URL; the org's fall back to the files. */
export function projectSection(
  section: ContextSection | undefined,
): ProjectSection {
  return section === "instructions" ||
    section === "general" ||
    section === "connections" ||
    section === "site"
    ? section
    : "files";
}

type Group = {
  labelKey?: TranslationKey;
  items: { id: ContextSection; labelKey: TranslationKey; Icon: Icon }[];
};

const ORG_GROUPS: Group[] = [
  {
    items: [
      { id: "files", labelKey: "library.context.allFiles", Icon: Folder },
      { id: "brand", labelKey: "library.context.brand", Icon: MagicWand02 },
      {
        id: "connections",
        labelKey: "settings.nav.connections",
        Icon: ZapSquare,
      },
      {
        id: "repositories",
        labelKey: "settings.nav.repositories",
        Icon: GitBranch01,
      },
    ],
  },
  {
    labelKey: "library.context.agents",
    items: [
      { id: "skills", labelKey: "settings.nav.skills", Icon: Stars01 },
      { id: "memory", labelKey: "settings.nav.memory", Icon: Lightbulb02 },
    ],
  },
];

const PROJECT_GROUPS: Group[] = [
  {
    items: [
      { id: "files", labelKey: "library.context.allFiles", Icon: Folder },
    ],
  },
  {
    labelKey: "library.context.thisProject",
    items: [
      {
        id: "instructions",
        labelKey: "virtualMcp.virtualMcp.instructions",
        Icon: BookOpen01,
      },
      ...(["connections", "site", "general"] as const).map((id) => ({
        id,
        labelKey: PROJECT_SETTINGS_SECTIONS[id].titleKey,
        Icon: PROJECT_SETTINGS_SECTIONS[id].icon,
      })),
    ],
  },
];

/** Scrolls the phone's sideways section row to the open section, and nothing else. */
function revealInRow(node: HTMLAnchorElement | null) {
  const row = node?.closest("nav");
  if (!node || !row || row.scrollWidth <= row.clientWidth) return;
  row.scrollLeft = node.offsetLeft - (row.clientWidth - node.offsetWidth) / 2;
}

const ROW = "flex shrink-0 items-center rounded-lg text-sm transition-colors";
const rowState = (active: boolean) =>
  active
    ? "bg-accent font-medium text-foreground"
    : "text-muted-foreground hover:bg-accent hover:text-foreground";

function ContextNav({
  groups,
  section,
}: {
  groups: Group[];
  section: ContextSection;
}) {
  const t = useT();
  return (
    <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-3 py-2 md:w-[216px] md:flex-col md:gap-5 md:overflow-y-auto md:border-b-0 md:pt-4 md:pr-1">
      {groups.map((group) => (
        <div
          key={group.labelKey ?? "main"}
          className="flex shrink-0 gap-1 md:flex-col md:gap-0.5"
        >
          {group.labelKey && (
            <span className="hidden px-2.5 pb-1 text-xs text-muted-foreground md:block">
              {t(group.labelKey)}
            </span>
          )}
          {group.items.map(({ id, labelKey, Icon }) => (
            <Link
              key={id}
              ref={id === section ? revealInRow : undefined}
              to="."
              search={
                id === "files"
                  ? { section: undefined, path: undefined }
                  : { section: id }
              }
              activeOptions={{ includeSearch: true, explicitUndefined: true }}
              className={cn(
                ROW,
                "h-8 gap-2.5 px-2.5",
                rowState(id === section),
              )}
            >
              <Icon size={16} className="shrink-0" />
              {t(labelKey)}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function ContextShell({
  scope = "org",
  section,
  children,
}: {
  scope?: "org" | "project";
  section: ContextSection;
  children: ReactNode;
}) {
  const t = useT();
  const groups = scope === "org" ? ORG_GROUPS : PROJECT_GROUPS;
  const label = groups
    .flatMap((group) => group.items)
    .find((item) => item.id === section)?.labelKey;
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Files trail their folders after the page crumb themselves. */}
      {section !== "files" && label && (
        <Page.Breadcrumbs
          after="page"
          parent={{ link: { to: ".", search: {} } }}
          items={[{ key: "context-section", label: t(label) }]}
        />
      )}
      <ContextNav groups={groups} section={section} />
      {/* Each section's tabs and filters sit over its own column, so the menu never moves. */}
      <Panel.Toolbar.Scope>
        {/* Without a toolbar the page itself starts on the menu's first row. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:pt-2.5 md:[&:not(:has([data-toolbar-content]:not(:empty)))]:pt-0">
          <Panel.Toolbar className={cn(PAGE_INSET, "py-0")}>
            <Panel.Toolbar.Left>
              <Panel.Toolbar.Left.Target />
            </Panel.Toolbar.Left>
            {/* On a phone a section's search takes what the filters leave, or a row of its own. */}
            <Panel.Toolbar.Right className="max-md:grow">
              <Panel.Toolbar.Right.Target />
            </Panel.Toolbar.Right>
          </Panel.Toolbar>
          <Page.Container.Inset value>
            {section === "files" ? (
              children
            ) : (
              <Page.Breadcrumbs.Detached>{children}</Page.Breadcrumbs.Detached>
            )}
          </Page.Container.Inset>
        </div>
      </Panel.Toolbar.Scope>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}

/** Every section but the files, which the Library route renders itself. */
export function ContextSectionBody({
  section,
}: {
  section: Exclude<OrgSection, "files">;
}) {
  switch (section) {
    case "brand":
      return (
        <Page>
          <Page.Content>
            <Page.Container>
              <BrandOverview />
            </Page.Container>
          </Page.Content>
        </Page>
      );
    case "connections":
      return (
        <Suspense fallback={<Loading />}>
          <OrgMcps />
        </Suspense>
      );
    case "repositories":
      return (
        <Page>
          <Page.Content>
            <Page.Container>
              <RequireCapability capability="file-configs:manage" area="files">
                <Suspense fallback={<Loading />}>
                  <SettingsPage>
                    <RepositoriesContent guided />
                  </SettingsPage>
                </Suspense>
              </RequireCapability>
            </Page.Container>
          </Page.Content>
        </Page>
      );
    case "skills":
      return (
        <Suspense fallback={<Loading />}>
          <SkillsPage />
        </Suspense>
      );
    case "memory":
      return (
        <Suspense fallback={<Loading />}>
          <MemoryPage />
        </Suspense>
      );
    default: {
      const unhandled: never = section;
      return unhandled;
    }
  }
}
