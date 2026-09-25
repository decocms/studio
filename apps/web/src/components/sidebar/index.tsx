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

/** Cloudflare's "← Back to Domains", for a project.
 *  It renders on the RAW scope, not the resolved project. A `?virtualmcpid=`
 *  naming a project you cannot see — deleted, revoked, or just not loaded yet —
 *  otherwise hides the project rows AND Library AND this row, leaving a sidebar
 *  scoped to nothing with no way out of it. The param is retained across every
 *  navigation, so that state is permanent, not transient. */
function ProjectBackRow({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const scopeId = useScopeId();
  const exitToOrg = useExitProjectScope();

  if (!scopeId) return null;

  return (
    <SidebarBackRow
      label={t("sidebar.scope.allProjects")}
      /** Not a link: where leaving lands depends on whether this route
       *  RESOLVES the scope, which only `useExitProjectScope` knows. */
      onSelect={() => {
        exitToOrg();
        onNavigate?.();
      }}
    />
  );
}

/** The body: the destinations you can reach from here, then the projects list.
 *  Settings is one of those destinations, not a zone of its own — it used to sit
 *  in a third group under an "Organization" heading, which made a row that
 *  behaves like Home read as a different kind of thing.
 *  No Suspense boundary, deliberately. Nothing in here blocks: the destinations
 *  are literals and the project zone reads its list non-blocking, so the whole
 *  nav paints on the first frame. A boundary used to wrap this because the body
 *  listed one row per project off a suspense query — restoring either would put
 *  a skeleton back in front of the sidebar. */
function OrgSidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <ErrorBoundary>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <NavDestinationsContent onNavigate={onNavigate} />
          <ProjectNav onNavigate={onNavigate} />
          <NavSettingsRow onNavigate={onNavigate} />
        </div>
        <SidebarProjectsSection onNavigate={onNavigate} />
      </div>
    </ErrorBoundary>
  );
}

export function StudioSidebar() {
  const inSettings = useInSettings();

  return (
    <SidebarShell
      header={<SidebarPickerHeader />}
      back={inSettings ? <SettingsBackRow /> : <ProjectBackRow />}
      body={inSettings ? <SettingsNav /> : <OrgSidebarBody />}
      footer={inSettings ? <SettingsVersion /> : <SidebarAccountFooter />}
    />
  );
}

export function StudioSidebarMobile({ onClose }: { onClose: () => void }) {
  const inSettings = useInSettings();

  return (
    <SidebarShell
      sheet
      header={<SidebarPickerHeaderMobile onClose={onClose} />}
      back={
        inSettings ? (
          <SettingsBackRow onNavigate={onClose} />
        ) : (
          <ProjectBackRow onNavigate={onClose} />
        )
      }
      body={
        inSettings ? (
          <SettingsNav onNavigate={onClose} />
        ) : (
          <OrgSidebarBody onNavigate={onClose} />
        )
      }
      footer={inSettings ? <SettingsVersion /> : <SidebarAccountFooterMobile />}
    />
  );
}
