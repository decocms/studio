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
import { Button } from "@deco/ui/components/button.tsx";
import { Card, CardContent } from "@deco/ui/components/card.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import {
  isDecopilot,
  useVirtualMCPActions,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { GitHubRepoPicker } from "@/web/components/github-repo-picker.tsx";
import {
  agentHasClonableSource,
  getDevAgentIds,
} from "@/web/lib/agent-capabilities";

export function DevAgentSetup({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
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

  const linkedId = virtualMcp.metadata?.devAgentId ?? null;
  const linked = linkedId
    ? (allAgents ?? []).find((a) => a.id === linkedId)
    : null;

  const setDevAgent = (devAgentId: string | null) =>
    actions.update
      .mutateAsync({
        id: virtualMcp.id,
        data: { metadata: { ...virtualMcp.metadata, devAgentId } },
      })
      .catch(() => {
        // mutateAsync already surfaced the error via toast.
      });

  const linkableAgents = (allAgents ?? []).filter(
    (a) =>
      a.id !== virtualMcp.id &&
      agentHasClonableSource(a.metadata) &&
      !devAgentIds.has(a.id),
  );

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Development agent</h2>
      <Card className="p-6 gap-4">
        <CardContent className="p-0 space-y-4">
          {linkedId ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm text-foreground truncate">
                  {linked ? linked.title : linkedId}
                </span>
                <span className="text-xs text-muted-foreground">
                  Linked dev agent — its sandbox dev server powers the
                  Develop/Live toggle in the header.
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void setDevAgent(null)}
              >
                Unlink
              </Button>
            </div>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">
                Link a GitHub-backed dev agent. Its sandbox dev server powers a
                Develop/Live toggle so you can develop and test this agent's MCP
                app.
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => setGithubOpen(true)}
                >
                  <GitHubIcon className="size-4" />
                  Import from GitHub
                </Button>
                {linkableAgents.length > 0 ? (
                  <Select onValueChange={(id) => void setDevAgent(id)}>
                    <SelectTrigger size="sm" className="w-56">
                      <SelectValue placeholder="Or link an existing dev agent…" />
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
        title="Import a dev agent from GitHub"
        onImportComplete={({ virtualMcpId }) => {
          setGithubOpen(false);
          void setDevAgent(virtualMcpId);
        }}
      />
    </div>
  );
}
