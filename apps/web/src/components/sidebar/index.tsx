/** The org shell's ONE sidebar. Every route under `/$org` — the destinations
 *  AND the settings tree — renders this same component, so the `<Sidebar>`, its
 *  scroll container, its collapse context and its picker header are the SAME
 *  DOM on both sides of that crossing; only the back/body/footer slots swap.
 *
 *  The branch is INSIDE this component, on the slot props, and has to stay
 *  there: a `{inSettings ? <A/> : <B/>}` at the CALL SITE would put a different
 *  component type at the same position, which unmounts the whole sidebar and
 *  rebuilds it — exactly the bug this replaced.
 *
 *  HOW the slots are spaced lives in `SidebarShell` and only there. */

import { ErrorBoundary } from "@/components/error-boundary";
import { AgentSwitcherCrumb } from "@/components/header/shell-breadcrumb";
import { useExitProjectScope } from "@/hooks/use-exit-project-scope";
import { useInSettings } from "@/hooks/use-in-settings";
import { useScopeId } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { SidebarAccountFooter } from "./footer/sidebar-footer";
import { SidebarAccountFooterMobile } from "./footer/sidebar-footer-mobile";
import { SidebarPickerHeader, SidebarPickerHeaderMobile } from "./header";
import { NavDestinationsContent } from "./nav-destinations";
import { SidebarBackRow } from "./nav-row";
import { NavSettingsRow } from "./nav-settings-row";
import { ProjectNav } from "./project-nav";
import { SidebarProjectsSection } from "./projects-section";
import {
  SettingsBackRow,
  SettingsNav,
  SettingsVersion,
} from "./settings-sidebar";
import { SidebarShell } from "./shell";
import { SidebarAgentGroupsProvider } from "./sidebar-agent-groups-context";

/** The org sheet's header: the shared mobile strip, plus the agent switcher so
 *  the agent can be changed from the sheet. It is added HERE and not in the
 *  shared strip because it reads the thread manager, which the settings route
 *  tree does not mount. Picking anything closes the sheet (`onClose`) so the
 *  chosen chat is visible. */
function OrgSidebarHeaderMobile({ onClose }: { onClose: () => void }) {
  return (
    <SidebarPickerHeaderMobile onClose={onClose}>
      <AgentSwitcherCrumb onNavigate={onClose} />
    </SidebarPickerHeaderMobile>
  );
}

/** Cloudflare's "← Back to Domains", for an agent workspace. It reads the raw
 * route identity so a deleted or inaccessible agent still has an exit. */
function ProjectBackRow({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const scopeId = useScopeId();
  const exitToOrg = useExitProjectScope();

  if (!scopeId) return null;

  return (
    <SidebarBackRow
      label={t("sidebar.scope.allProjects")}
      /** The shared exit action owns analytics and the canonical Home target. */
      onSelect={() => {
        exitToOrg();
        onNavigate?.();
      }}
    />
  );
}

/** The body: org-wide destinations, then the scoped project's own rows, then
 *  Settings — LAST by construction, being a sibling of both lists rather than a
 *  member of either, so the project zone rendering nothing cannot move it.
 *  No Suspense boundary, deliberately. Nothing in here blocks: the destinations
 *  are literals and the project zone reads its list non-blocking, so the whole
 *  nav paints on the first frame. A boundary used to wrap this because the body
 *  listed one row per project off a suspense query — restoring either would put
 *  a skeleton back in front of the sidebar. */
function OrgSidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <ErrorBoundary>
      <div className="flex flex-col gap-1">
        <NavDestinationsContent onNavigate={onNavigate} />
        <ProjectNav onNavigate={onNavigate} />
        {/* Settings closes the DESTINATIONS, above the project list. The list
            grows with the org and nests a few rows under each entry, so a row
            pinned after it drifts further from the fixed nav it belongs to on
            every project added — and lands at the bottom of a scroll on a big
            org. Everything above this rule is a place; everything below is the
            org's map. */}
        <NavSettingsRow onNavigate={onNavigate} />
        <SidebarProjectsSection onNavigate={onNavigate} />
      </div>
    </ErrorBoundary>
  );
}

export function StudioSidebar() {
  const inSettings = useInSettings();

  return (
    <SidebarAgentGroupsProvider>
      <SidebarShell
        header={<SidebarPickerHeader />}
        back={inSettings ? <SettingsBackRow /> : <ProjectBackRow />}
        body={inSettings ? <SettingsNav /> : <OrgSidebarBody />}
        footer={inSettings ? <SettingsVersion /> : <SidebarAccountFooter />}
      />
    </SidebarAgentGroupsProvider>
  );
}

export function StudioSidebarMobile({ onClose }: { onClose: () => void }) {
  return (
    <SidebarAgentGroupsProvider>
      <SidebarShell
        sheet
        header={<OrgSidebarHeaderMobile onClose={onClose} />}
        back={<ProjectBackRow onNavigate={onClose} />}
        body={<OrgSidebarBody onNavigate={onClose} />}
        footer={<SidebarAccountFooterMobile />}
      />
    </SidebarAgentGroupsProvider>
  );
}
