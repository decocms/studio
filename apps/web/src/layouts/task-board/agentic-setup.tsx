/** "Agentic Setup": a Super Agent chat, beside the board, that interviews the user and writes the column rules. */

import { useState } from "react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { Stars02 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { useThreadActions } from "@/components/chat/store/hooks";
import { createMentionDoc } from "@/components/chat/tiptap/mention";
import type { TiptapDoc } from "@/components/chat/types";
import { useT } from "@/i18n/use-t.ts";
import {
  canonicalThreadRouteTarget,
  navigateToTabRouteTarget,
} from "@/layouts/main-panel-tabs/tab-route";
import { AUTOSEND_QUERY_VALUE, writeStoredAutosend } from "@/lib/autosend";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";
import { useBoardOrgSlug } from "./board-org";
// Bundled rather than read from the synced `core` set, which lags this repo until merged to main.
import setupSkill from "../../../../../packages/sandbox/image/skills/task-board-setup/SKILL.md?raw";

export function AgenticSetupButton() {
  const t = useT();
  const navigate = useNavigate();
  const { org, locator } = useProjectContext();
  const { create } = useThreadActions();
  const [starting, setStarting] = useState(false);
  // The chat runs in the viewer's own org, so it can't configure a board viewed cross-org.
  if (useBoardOrgSlug()) return null;

  const start = async () => {
    setStarting(true);
    try {
      const doc: TiptapDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              createMentionDoc({
                id: "core/task-board-setup",
                name: "task-board-setup",
                char: "/",
                kind: "skill",
                metadata: {
                  sandboxPath: "",
                  volume: "public-core",
                  path: "task-board-setup",
                  files: [{ relPath: "SKILL.md", content: setupSkill }],
                  omittedPaths: [],
                },
              }),
              { type: "text", text: ` ${t("taskBoard.agenticSetup.message")}` },
            ],
          },
        ],
      };
      const newId = crypto.randomUUID();
      const agentId = getWellKnownDecopilotVirtualMCP(org.id).id;
      writeStoredAutosend(sessionStorage, locator, newId, { tiptapDoc: doc });
      // Store toasts on failure; the route's ensure-fallback retries the create.
      await create({ id: newId, virtual_mcp_id: agentId }).catch(() => {});
      // tabId "board" keeps the org board in main; Tasks defaults the chat panel closed.
      navigateToTabRouteTarget(
        navigate,
        canonicalThreadRouteTarget({
          org: org.slug,
          agentId,
          superAgentId: agentId,
          tabId: "board",
        }),
        {
          search: () => ({
            thread: newId,
            sidepanel: true,
            autosend: AUTOSEND_QUERY_VALUE,
          }),
          replace: false,
        },
      );
    } catch {
      toast.error(t("taskBoard.agenticSetup.failed"));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Button size="sm" variant="outline" disabled={starting} onClick={start}>
      <Stars02 size={16} />
      {t("taskBoard.agenticSetup.button")}
    </Button>
  );
}
