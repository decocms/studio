/** ONE Settings row, two targets, always the sidebar's last element.
 *  Scoped to a project it opens THAT project's settings panel; unscoped, the
 *  org's settings tree. It is a sibling of the two nav lists rather than a
 *  member of either, because "last" is a property of the list's ORDER — owned
 *  by the sidebar's body — and a row that must always exist cannot live
 *  inside the project zone, which renders nothing for an org with no projects.
 *  The target is the raw scope off the URL, so it needs no query, is right on
 *  the first painted frame, and cannot disagree with the picker. */

import type { LinkProps } from "@tanstack/react-router";
import { Settings02 } from "@untitledui/icons";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import {
  DESTINATION_ROUTE,
  useActivePanelSegment,
  useLeafRoutePath,
} from "@/hooks/use-destination-route";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { useScopeId } from "@/hooks/use-project-scope";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { SidebarNavRow } from "./nav-row";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { SETTINGS_DESTINATION } from "./nav-destinations";

export function NavSettingsRow({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const { org } = useProjectContext();
  const scopeId = useScopeId();
  const navigateToAgent = useNavigateToAgent();
  const leafPath = useLeafRoutePath();
  const activePanel = useActivePanelSegment();

  /** EITHER settings surface highlights the one row: with a single control for
   *  both, "you are in settings" is the fact worth showing, and a target-only
   *  check leaves a dead state — someone scoped to a project but sitting in the
   *  org tree would see the row point at the project and light up nothing. The
   *  org branch is defensive: the settings tree is its own shell with its own
   *  sidebar, so this row is not rendered while it is open. */
  const isActive =
    leafPath.startsWith("/$org/settings") ||
    (leafPath === DESTINATION_ROUTE.agents && activePanel === "settings");

  /** One label for both targets. Which settings it opens is already said by
   *  the sidebar it sits in — a project's sidebar names the project at the top
   *  — so saying it again on the row only makes the two contexts look like two
   *  different controls. */
  const label = t("sidebar.navDestinations.settings");

  /** Unscoped this stays a real anchor, so middle-click and open-in-new-tab
   *  keep working as they do for every other org-wide destination. Scoped there
   *  is no `link` and the row is a button: a project's settings live in a panel
   *  of a SESSION, and which session that is is not knowable at render time —
   *  the same reason the project rows above are buttons. */
  const link: LinkProps | undefined = scopeId
    ? undefined
    : { to: "/$org/settings", params: { org: org.slug } };

  return (
    <SidebarMenu className="gap-1">
      <SidebarNavRow
        dataTour={LAYOUT_TOUR_ANCHORS.settings}
        icon={<Settings02 size={16} />}
        label={label}
        isActive={isActive}
        link={link}
        onSelect={() => {
          track("nav_destination_clicked", {
            destination: SETTINGS_DESTINATION,
            target: scopeId ? "project" : "org",
          });
          if (scopeId) navigateToAgent(scopeId, { panel: "settings" });
          onNavigate?.();
        }}
      />
    </SidebarMenu>
  );
}
