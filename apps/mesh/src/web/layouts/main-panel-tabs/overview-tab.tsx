/**
 * Overview tab — the Super Agent's default main view.
 *
 * There is no bespoke "home" screen anymore: the org landing is just the Super
 * Agent, and the Super Agent opens on this view (its
 * `metadata.ui.layout.defaultMainView = { type: "overview" }`). It's a plain
 * main-panel view like Settings or Automations — any agent could point at it.
 *
 * For the demo it renders the scripted home dashboard (see DemoHome): an agent
 * summary, store/coding metrics, and the tasks needing review.
 */
import { useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { DemoHome } from "@/web/components/home/demo-home";
import { CommerceDiscoveryModal } from "@/web/components/home/commerce-discovery-modal";
import { useNeedsRuntimeSetup } from "@/web/components/chat/use-needs-runtime-setup";
import { NoAiProviderEmptyState } from "@/web/components/chat/no-ai-provider-empty-state";

export function OverviewTab() {
  const needsSetup = useNeedsRuntimeSetup();
  const { connect } = useSearch({ strict: false });
  // Auto-open when arriving from /commerce-onboarding (`?connect=1`). Read once
  // into state so closing it stays closed even though the URL param persists.
  const [connectOpen, setConnectOpen] = useState(connect === "1");

  if (needsSetup) {
    return (
      <div className="h-full overflow-y-auto flex items-center justify-center p-6">
        <NoAiProviderEmptyState />
      </div>
    );
  }

  return (
    <>
      <DemoHome onConnectIntegrations={() => setConnectOpen(true)} />
      {connectOpen && (
        <CommerceDiscoveryModal onClose={() => setConnectOpen(false)} />
      )}
    </>
  );
}
