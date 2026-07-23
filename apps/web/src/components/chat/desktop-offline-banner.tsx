/**
 * DesktopOfflineBanner — proactive warning for threads pinned to the user's
 * desktop (`sandbox_provider_kind = "user-desktop"`) while the link daemon is
 * offline.
 *
 * Without it the user only learns at send time, via the POST /messages 409
 * (`user_desktop_link_offline`) — after typing a whole message. The thread is
 * permanently bound to the desktop runtime (harness lock), so the only
 * remedy is bringing the link back; the banner says that up front and offers
 * the connect-desktop flow.
 *
 * Self-contained on purpose (same pattern as TodosHighlight): reads the chat
 * task context and link presence itself, renders nothing when the thread
 * isn't desktop-pinned, the link state hasn't loaded yet, or the desktop is
 * online. `useCurrentLink` polls LINK_CURRENT_GET, so the banner clears on
 * its own once the daemon reconnects.
 */

import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { Monitor01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { useCurrentLink } from "@/hooks/use-current-link";
import { useOptionalChatTask } from "./chat-context";
import { ConnectDesktopDialog } from "./connect-desktop-dialog";
import { CollapsibleHighlight } from "./highlight/collapsible-highlight";

export function DesktopOfflineBanner() {
  const t = useT();
  const taskCtx = useOptionalChatTask();
  const link = useCurrentLink();
  const [connectOpen, setConnectOpen] = useState(false);

  const lockedToDesktop = taskCtx?.lockedSandbox === "user-desktop";
  if (!lockedToDesktop || !link.ready || link.online) return null;

  return (
    <>
      <CollapsibleHighlight
        icon={<Monitor01 size={14} />}
        label={t("chat.desktopOfflineBanner.label")}
        title={t("chat.desktopOfflineBanner.title")}
        defaultExpanded={true}
        variant="warning"
        footerRight={
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setConnectOpen(true)}
          >
            {t("chat.desktopOfflineBanner.reconnectButton")}
          </Button>
        }
      >
        <p className="mx-4 text-xs text-muted-foreground">
          {t("chat.desktopOfflineBanner.instructions")}
        </p>
      </CollapsibleHighlight>
      <ConnectDesktopDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </>
  );
}
