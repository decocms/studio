/** The org rail's Help mark: where to read, where to ask, and how to reach
 *  the deco team from inside Studio. */

import { useState } from "react";
import {
  AlertTriangle,
  BookOpen01,
  HelpCircle,
  MessageChatSquare,
} from "@untitledui/icons";
import type { FeedbackKind } from "@decocms/shared/feedback";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { useProjectContext } from "@/sdk";
import { FeedbackDialog } from "./feedback-dialog";
import { RailItem } from "./rail-item";

const GUIDES_URL = "https://docs.decocms.com/";
const DISCORD_URL = "https://discord.gg/EQkX7CymV";

export function HelpMenu() {
  const t = useT();
  const { org } = useProjectContext();
  const [dialog, setDialog] = useState<FeedbackKind | null>(null);
  /** Feedback is filed through the current org, so it needs one. */
  const canSend = !!org.id;

  const openDialog = (kind: FeedbackKind) => {
    track("help_menu_dialog_opened", { kind });
    setDialog(kind);
  };

  return (
    <>
      <RailItem active={false}>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("sidebar.help.button")}
                  onClick={() => track("help_menu_opened")}
                  className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-ring data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
                >
                  <HelpCircle size={18} />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">
              {t("sidebar.help.button")}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="right" align="end" className="w-56">
            <DropdownMenuItem asChild>
              <a
                href={GUIDES_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => track("help_menu_guides_opened")}
              >
                <BookOpen01 />
                {t("sidebar.help.guides")}
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a
                href={DISCORD_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => track("help_menu_discord_opened")}
              >
                <DiscordIcon />
                {t("sidebar.help.discord")}
              </a>
            </DropdownMenuItem>
            {canSend && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openDialog("problem")}>
                  <AlertTriangle />
                  {t("sidebar.help.reportProblem")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openDialog("feedback")}>
                  <MessageChatSquare />
                  {t("sidebar.feedback.button")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </RailItem>
      {canSend && (
        <>
          <FeedbackDialog
            kind="problem"
            open={dialog === "problem"}
            onOpenChange={(open) => setDialog(open ? "problem" : null)}
          />
          <FeedbackDialog
            kind="feedback"
            open={dialog === "feedback"}
            onOpenChange={(open) => setDialog(open ? "feedback" : null)}
          />
        </>
      )}
    </>
  );
}
