import { Folder } from "@untitledui/icons";
import { HeaderTabButton } from "@/web/layouts/main-panel-tabs/header-tab-button";
import { track } from "@/web/lib/posthog-client";
import { useT } from "@/web/i18n/use-t";
import { useReportsOnly } from "@/web/hooks/use-organization-settings";
import { useMainOverlayToggle } from "./use-main-overlay-toggle";

/**
 * Library toggle — sits in the LEFT toolbar group beside the Chat toggle.
 *
 * The Library (org files/assets) is agent-independent — it's the same view for
 * every agent — so it doesn't belong in the per-agent view tab bar on the
 * right. Pinning it next to Chat keeps a stable, always-present entry point
 * that never shuffles as agent-specific tabs (Overview / Preview / …) come and
 * go. Opens `?main=files`; clicking while open restores the previously shown
 * tab (see useMainOverlayToggle) rather than closing the panel outright.
 */
export function LibraryToggle() {
  const t = useT();
  const reportsOnly = useReportsOnly();
  const { active, enabled, toggle } = useMainOverlayToggle("files");

  // Needs a task route to toggle the main panel against; render nothing on
  // routes without one. Commerce (reports-only) orgs hide the Library button.
  if (!enabled || reportsOnly) return null;

  return (
    <HeaderTabButton
      title={t("agentShellLayout.libraryToggle.library")}
      icon={{ kind: "component", Component: Folder }}
      active={active}
      className="wco-no-drag h-10 md:h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => {
        track("agent_toolbar_toggled", {
          button: "library",
          next_state: active ? "closed" : "open",
        });
        toggle();
      }}
    />
  );
}
