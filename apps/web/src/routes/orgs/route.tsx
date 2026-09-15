import { Outlet } from "@tanstack/react-router";
import { Layout } from "@/components/layout";
import { OrgNoticeBanner } from "@/components/org-notice-banner";
import { StudioSidebar, StudioSidebarMobile } from "@/components/sidebar";
import { useInSettings } from "@/hooks/use-in-settings";
import { useStatusSounds } from "@/hooks/use-status-sounds";
import { useProjectContext } from "@/sdk";

/** Stays mounted when navigating between organization and project destinations. */
export default function OrgRoute() {
  const inSettings = useInSettings();
  const { org } = useProjectContext();
  useStatusSounds(org.slug);

  return (
    <Layout expandedSidebar={inSettings} notice={<OrgNoticeBanner />}>
      <Layout.Sidebar
        renderMobile={({ onClose }) => (
          <StudioSidebarMobile onClose={onClose} />
        )}
      >
        <StudioSidebar />
      </Layout.Sidebar>
      <Layout.Content>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}
