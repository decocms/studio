/**
 * OrgHome — leaf component for /$org/. Renders HomePage inside the same
 * panel chrome the chat surface uses, full-bleed (no chat-main split).
 *
 * No Chat.Provider, no ActiveTaskProvider — the home composer is wired
 * to the home submit path (URL autosend handoff) via Chat.Input's
 * optional-context fallback.
 */

import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { Navigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { HomePage } from "@/web/layouts/home-page";
import { useReportsOnlyGate } from "@/web/hooks/use-organization-settings";

export default function OrgHome() {
  const isMobile = useIsMobile();
  const { org } = useProjectContext();
  const reportsOnly = useReportsOnlyGate();

  // Reports-only orgs have no home surface — send them straight to
  // the reports diagnostic panel (a standalone route with no product chrome).
  if (reportsOnly) {
    return (
      <Navigate to="/commerce-onboarding" search={{ org: org.slug }} replace />
    );
  }

  if (isMobile) {
    return (
      <div className="flex-1 min-h-0 flex flex-col bg-background overflow-hidden">
        <HomePage />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 pb-1 pr-1 pl-0 pt-0">
      <div className="h-full p-0.5 pt-0.25">
        <div className="flex flex-col h-full bg-background overflow-hidden card-shadow rounded-[0.75rem]">
          <HomePage />
        </div>
      </div>
    </div>
  );
}
