/**
 * OrgHome — leaf component for /$org/. Renders HomePage inside the same
 * panel chrome the chat surface uses, full-bleed (no chat-main split).
 *
 * No Chat.Provider, no ActiveTaskProvider — the home composer is wired
 * to the home submit path (URL autosend handoff) via Chat.Input's
 * optional-context fallback.
 */

import { HomePage } from "@/web/layouts/home-page";

export default function OrgHome() {
  return (
    <div className="flex-1 min-h-0 p-1.5 overflow-hidden">
      <div className="flex h-full flex-col bg-background overflow-hidden card-shadow rounded-[0.75rem]">
        <HomePage />
      </div>
    </div>
  );
}
