/**
 * "Development agent" settings section. Lets a (live) agent link a
 * GitHub-backed dev agent whose sandbox dev server powers the Develop/Live
 * toggle in the header. Lives in the agent settings view — the header only
 * shows the toggle, and only once a pair exists.
 *
 * Hidden for agents that are themselves a dev agent (have a `githubRepo`) or
 * Decopilot — those don't link a separate dev counterpart.
 */

import { useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card, CardContent } from "@decocms/ui/components/card.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { isDecopilot, useVirtualMCPActions, useVirtualMCPs } from "@/sdk";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useT } from "@/i18n/use-t.ts";
import { GitHubIcon } from "@/components/icons/github-icon";
import { GitHubRepoPicker } from "@/components/github-repo-picker.tsx";
import {
  agentHasClonableSource,
  getDevAgentIds,
} from "@/lib/agent-capabilities";

export function DevAgentSetup({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
  const t = useT();
  const allAgents = useVirtualMCPs();
  const actions = useVirtualMCPActions();
  const [githubOpen, setGithubOpen] = useState(false);

  const devAgentIds = getDevAgentIds(allAgents);
  // Only "live"-style agents set up a dev counterpart: not Decopilot, not
  // itself a dev agent (githubRepo), and not already the dev side of a pair.
  if (
    isDecopilot(virtualMcp.id) ||
    agentHasClonableSource(virtualMcp.metadata) ||
    devAgentIds.has(virtualMcp.id)
  ) {
    return null;
  }

  // The pairing ref lives on the dev agent (`metadata.liveAgentId`) so the
  // server gates dev-connection injection with a local field check (no
  // per-request reverse lookup). This view sits on the live agent, so its dev
  // counterpart is found by reverse scan, and link/unlink writes the DEV row.
  const linked =
    (allAgents ?? []).find((a) => a.metadata?.liveAgentId === virtualMcp.id) ??
    null;
  const linkedId = linked?.id ?? null;

  // Stamp `liveAgentId` on the dev agent's row by id. VIRTUAL_MCP_UPDATE
  // shallow-merges metadata server-side, so we send only the changed key — no
  // need to spread the existing metadata, which crucially lets us link a
  // just-imported dev agent that isn't in the (async-refetched) `allAgents` list
  // yet (the GitHub-import path).
  const setLiveAgentId = (devAgentId: string, liveAgentId: string | null) =>
    actions.update
      .mutateAsync({
        id: devAgentId,
        // VIRTUAL_MCP_UPDATE shallow-merges metadata server-side, so send only
        // the changed key — the merge preserves everything else, and crucially
        // this needs no read of the dev agent's current metadata (which a
        // just-imported agent isn't in `allAgents` for yet). The mutation type
        // models the full metadata object, so assert through the partial.
        data: {
          metadata: { liveAgentId } as unknown as NonNullable<
            VirtualMCPEntity["metadata"]
          >,
        },
      })
      .catch(() => {
        // mutateAsync already surfaced the error via toast.
      });

  const linkDevAgent = (devAgentId: string) =>
    void setLiveAgentId(devAgentId, virtualMcp.id);
  const unlinkDevAgent = () => {
    if (linkedId) void setLiveAgentId(linkedId, null);
  };

  const linkableAgents = (allAgents ?? []).filter(
    (a) =>
      a.id !== virtualMcp.id &&
      agentHasClonableSource(a.metadata) &&
      !devAgentIds.has(a.id),
  );

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">
        {t("devAgent.devAgentSetup.title")}
      </h2>
      <Card className="p-6 gap-4">
        <CardContent className="p-0 space-y-4">
          {linkedId ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm text-foreground truncate">
                  {linked ? linked.title : linkedId}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("devAgent.devAgentSetup.linkedDescription")}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={unlinkDevAgent}
              >
                {t("devAgent.devAgentSetup.unlinkButton")}
              </Button>
            </div>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">
                {t("devAgent.devAgentSetup.linkDescription")}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => setGithubOpen(true)}
                >
                  <GitHubIcon className="size-4" />
                  {t("devAgent.devAgentSetup.importButton")}
                </Button>
                {linkableAgents.length > 0 ? (
                  <Select onValueChange={linkDevAgent}>
                    <SelectTrigger size="sm" className="w-56">
                      <SelectValue
                        placeholder={t(
                          "devAgent.devAgentSetup.selectPlaceholder",
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {linkableAgents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <GitHubRepoPicker
        open={githubOpen}
        onOpenChange={setGithubOpen}
        title={t("devAgent.devAgentSetup.importDialogTitle")}
        onImportComplete={({ virtualMcpId }) => {
          setGithubOpen(false);
          linkDevAgent(virtualMcpId);
        }}
      />
    </div>
  );
}
