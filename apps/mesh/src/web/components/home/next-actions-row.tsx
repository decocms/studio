/**
 * NextActionsRow
 *
 * Renders below `Chat.Input` on the /$org home page. Two card kinds:
 *   - Prompt cards → open a new thread with an agent and autosend a prompt.
 *   - Dialog cards → open a client-side modal (storefront / GitHub / site
 *     monitoring). No thread is created.
 *
 * Server filters out completed items so the row stays pared down as the
 * user makes progress.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useProjectContext } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import { AddStorefrontModal } from "@/web/components/add-storefront-modal";
import { GitHubRepoPicker } from "@/web/components/github-repo-picker";
import { InstallGitHubMcpDialog } from "@/web/components/install-github-mcp-dialog";
import { SetupSiteMonitoringModal } from "@/web/components/setup-site-monitoring-modal";
import {
  type HomePromptEntry,
  type HomeDialogEntry,
  useHomeNextActions,
} from "@/web/hooks/use-home-next-actions";
import { useStartThreadFromPrompt } from "@/web/hooks/use-start-thread-from-prompt";
import { KEYS } from "@/web/lib/query-keys";

function PromptCard({
  entry,
  onClick,
}: {
  entry: HomePromptEntry;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/row flex w-72 grow basis-72 items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left outline-none transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AgentAvatar icon={entry.agentIcon} name={entry.agentName} size="sm+" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="w-full truncate text-xs text-muted-foreground">
          {entry.agentName}
        </div>
        <div className="line-clamp-2 w-full text-sm font-medium text-foreground">
          {entry.title}
        </div>
      </div>
    </button>
  );
}

function DialogCard({
  entry,
  onClick,
}: {
  entry: HomeDialogEntry;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/row flex w-72 grow basis-72 items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left outline-none transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AgentAvatar icon={entry.agentIcon} name={entry.agentName} size="sm+" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="w-full truncate text-xs text-muted-foreground">
          {entry.agentName}
        </div>
        <div className="line-clamp-2 w-full text-sm font-medium text-foreground">
          {entry.label}
        </div>
      </div>
    </button>
  );
}

function AgentPromptCardGroup({
  agentId,
  entries,
}: {
  agentId: string;
  entries: HomePromptEntry[];
}) {
  const { start, dialog } = useStartThreadFromPrompt({ agentId });

  const handleClick = (entry: HomePromptEntry) => {
    const prompt: Prompt = {
      name: entry.promptName,
      description: entry.description,
      arguments: entry.arguments,
    };
    void start(prompt);
  };

  return (
    <>
      {entries.map((entry) => (
        <PromptCard
          key={entry.promptName}
          entry={entry}
          onClick={() => handleClick(entry)}
        />
      ))}
      {dialog}
    </>
  );
}

function PromptCardRow({ entries }: { entries: HomePromptEntry[] }) {
  // Each agent's prompts get their own hook scope so the MCP client is
  // correctly keyed by virtual_mcp_id.
  const byAgent = new Map<string, HomePromptEntry[]>();
  for (const e of entries) {
    const existing = byAgent.get(e.agentId);
    if (existing) existing.push(e);
    else byAgent.set(e.agentId, [e]);
  }
  return (
    <>
      {Array.from(byAgent.entries()).map(([agentId, list]) => (
        <AgentPromptCardGroup key={agentId} agentId={agentId} entries={list} />
      ))}
    </>
  );
}

export function NextActionsRow() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const { isLoading, prompts, dialogs } = useHomeNextActions(org.slug);

  const [githubPickerOpen, setGithubPickerOpen] = useState(false);
  const [installGithubOpen, setInstallGithubOpen] = useState(false);
  const [addStorefrontOpen, setAddStorefrontOpen] = useState(false);
  const [siteMonitoringOpen, setSiteMonitoringOpen] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.homeNextActions(org.slug),
    });

  const handleDialogClick = (kind: HomeDialogEntry["kind"]) => {
    switch (kind) {
      case "github-import":
        setGithubPickerOpen(true);
        return;
      case "install-github-mcp":
        setInstallGithubOpen(true);
        return;
      case "add-storefront":
      case "configure-github-automations":
        setAddStorefrontOpen(true);
        return;
      case "setup-site-monitoring":
        setSiteMonitoringOpen(true);
        return;
    }
  };

  const isEmpty = !isLoading && prompts.length === 0 && dialogs.length === 0;
  if (isEmpty) return null;

  return (
    <>
      <div className="w-full max-w-5xl mt-4">
        <div className="flex flex-wrap gap-3">
          {isLoading ? (
            Array.from({ length: 3 }, (_, i) => (
              <div
                key={`skeleton-${i}`}
                className="flex w-72 grow basis-72 flex-col gap-1.5 rounded-xl border border-border bg-background px-3 py-2.5"
              >
                <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                <div className="h-2.5 w-full animate-pulse rounded bg-muted/70" />
              </div>
            ))
          ) : (
            <>
              <PromptCardRow entries={prompts} />
              {dialogs.map((d) => (
                <DialogCard
                  key={`${d.agentId}-${d.kind}`}
                  entry={d}
                  onClick={() => handleDialogClick(d.kind)}
                />
              ))}
            </>
          )}
        </div>
      </div>
      <GitHubRepoPicker
        open={githubPickerOpen}
        onOpenChange={(open) => {
          setGithubPickerOpen(open);
          if (!open) invalidate();
        }}
      />
      <InstallGitHubMcpDialog
        open={installGithubOpen}
        onOpenChange={(open) => {
          setInstallGithubOpen(open);
          if (!open) invalidate();
        }}
      />
      <AddStorefrontModal
        open={addStorefrontOpen}
        onOpenChange={(open) => {
          setAddStorefrontOpen(open);
          if (!open) invalidate();
        }}
      />
      <SetupSiteMonitoringModal
        open={siteMonitoringOpen}
        onOpenChange={(open) => {
          setSiteMonitoringOpen(open);
          if (!open) invalidate();
        }}
      />
    </>
  );
}
