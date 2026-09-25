import { Outlet } from "@tanstack/react-router";
import { Layout } from "@/components/layout";
import { OrgNoticeBanner } from "@/components/org-notice-banner";
import { StudioSidebar, StudioSidebarMobile } from "@/components/sidebar";
import { useStatusSounds } from "@/hooks/use-status-sounds";
import { useCheckoutReturn } from "@/hooks/use-checkout-return";
import { useAppTakeover } from "@/hooks/use-app-takeover";
import { useProjectContext } from "@/sdk";

/** Stays mounted when navigating between organization and project destinations. */
export default function OrgRoute() {
  const { org } = useProjectContext();
  useStatusSounds(org.slug);
  // Stripe's return lands somewhere under the org, not always on Billing,
  // and the tab that OPENED checkout is a different one — so the org frame
  // is the one place that sees every return.
  useCheckoutReturn(org.id);

  /** An app launched from a project's screen takes the screen — see
   *  `use-app-takeover.ts`. The breadcrumb's project crumb is the way back. */
  const takeover = useAppTakeover();

  return (
    <Layout notice={<OrgNoticeBanner />}>
      {!takeover && (
        <Layout.Sidebar
          renderMobile={({ onClose }) => (
            <StudioSidebarMobile onClose={onClose} />
          )}
        >
          <StudioSidebar />
        </Layout.Sidebar>
      )}
      <Layout.Content>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}
