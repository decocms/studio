/**
 * GitHub Registry Item Detail
 *
 * Detail view for a skill or agent from a GitHub registry.
 * Shows markdown content, metadata, and install/create actions.
 */

import { useState } from "react";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  BookOpen01,
  CubeOutline,
  Download01,
  Loading01,
  Plus,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { toast } from "sonner";
import {
  useGitHubRegistryItem,
  useGitHubRegistrySync,
} from "@/web/hooks/use-github-registry";

interface GitHubRegistryItemDetailProps {
  owner: string;
  repo: string;
  type: "skill" | "agent";
  name: string;
  onBack: () => void;
}

export function GitHubRegistryItemDetail({
  owner,
  repo,
  type,
  name,
  onBack,
}: GitHubRegistryItemDetailProps) {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const { data, isLoading, error } = useGitHubRegistryItem(
    owner,
    repo,
    type,
    name,
  );
  const syncMutation = useGitHubRegistrySync();
  const virtualMcpActions = useVirtualMCPActions();
  const virtualMcps = useVirtualMCPs();
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <Loading01 size={32} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    // Try syncing the repo first
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-sm text-muted-foreground">
          Could not load this item. The repository may need to be synced first.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => syncMutation.mutate({ owner, repo })}
          disabled={syncMutation.isPending}
        >
          {syncMutation.isPending ? (
            <Loading01 className="size-4 animate-spin" />
          ) : null}
          Sync Repository
        </Button>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const handleCreateAgent = async () => {
    setIsInstalling(true);
    try {
      const result = await virtualMcpActions.create.mutateAsync({
        title: data.name,
        description: data.description,
        icon: data.icon || null,
        status: "active",
        metadata: {
          instructions: data.instructions || data.body || null,
          source: `github:${owner}/${repo}`,
        },
        connections: [],
      });
      toast.success(`Agent "${data.name}" created`);
      navigate({
        to: "/$org/$project/agents/$agentId",
        params: {
          org: org.slug,
          project: ORG_ADMIN_PROJECT_SLUG,
          agentId: result.id!,
        },
      });
    } catch (e) {
      toast.error(
        `Failed to create agent: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    } finally {
      setIsInstalling(false);
    }
  };

  const handleAddToAgent = async (agentId: string) => {
    setIsInstalling(true);
    try {
      // Get the current agent to append the skill content to instructions
      const agent = virtualMcps?.find((v) => v.id === agentId);
      if (!agent) throw new Error("Agent not found");

      const currentInstructions =
        (agent.metadata as { instructions?: string })?.instructions || "";
      const skillContent = data.body || data.rawContent || "";
      const updatedInstructions = currentInstructions
        ? `${currentInstructions}\n\n---\n\n## Skill: ${data.name}\n\n${skillContent}`
        : `## Skill: ${data.name}\n\n${skillContent}`;

      await virtualMcpActions.update.mutateAsync({
        id: agentId,
        data: {
          metadata: {
            ...(agent.metadata as Record<string, unknown>),
            instructions: updatedInstructions,
          },
        },
      });

      toast.success(`Skill "${data.name}" added to agent "${agent.title}"`);
      setAgentPickerOpen(false);
      navigate({
        to: "/$org/$project/agents/$agentId",
        params: {
          org: org.slug,
          project: ORG_ADMIN_PROJECT_SLUG,
          agentId,
        },
      });
    } catch (e) {
      toast.error(
        `Failed to add skill: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    } finally {
      setIsInstalling(false);
    }
  };

  const handleCopyContent = async () => {
    await navigator.clipboard.writeText(data.rawContent);
    toast.success("Content copied to clipboard");
  };

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto py-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            {type === "skill" ? (
              <BookOpen01 className="size-5 text-muted-foreground" />
            ) : (
              <CubeOutline className="size-5 text-muted-foreground" />
            )}
            <span className="text-xs font-medium uppercase text-muted-foreground">
              {type}
            </span>
            <span className="text-xs text-muted-foreground">
              from {owner}/{repo}
            </span>
          </div>
          <h1 className="text-2xl font-semibold">{data.name}</h1>
          {data.description && (
            <p className="text-sm text-muted-foreground mt-1">
              {data.description}
            </p>
          )}
        </div>
      </div>

      {/* Skills listed (for agents) */}
      {data.skills && data.skills.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Skills</h3>
          <div className="flex flex-wrap gap-2">
            {data.skills.map((skill) => (
              <span
                key={skill}
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground"
              >
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Instructions preview (for agents) */}
      {data.instructions && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Instructions</h3>
          <pre className="rounded-lg border border-border bg-muted/30 p-4 text-xs whitespace-pre-wrap max-h-48 overflow-y-auto">
            {data.instructions}
          </pre>
        </div>
      )}

      {/* Markdown body */}
      {data.body && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Content</h3>
          <pre className="rounded-lg border border-border bg-muted/30 p-4 text-xs whitespace-pre-wrap max-h-96 overflow-y-auto">
            {data.body}
          </pre>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 border-t border-border pt-4">
        {type === "agent" ? (
          <Button onClick={handleCreateAgent} disabled={isInstalling}>
            {isInstalling ? (
              <Loading01 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Create Agent
          </Button>
        ) : (
          <Button
            onClick={() => setAgentPickerOpen(true)}
            disabled={isInstalling}
          >
            <Plus className="size-4" />
            Add to Agent
          </Button>
        )}
        <Button variant="outline" onClick={handleCopyContent}>
          <Download01 className="size-4" />
          Copy Raw Content
        </Button>
      </div>

      {/* Agent Picker Dialog */}
      <Dialog open={agentPickerOpen} onOpenChange={setAgentPickerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add skill to agent</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2 max-h-80 overflow-y-auto">
            {!virtualMcps || virtualMcps.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-6">
                <p className="text-sm text-muted-foreground">
                  No agents yet. Create one first.
                </p>
                <Button
                  size="sm"
                  onClick={async () => {
                    const result = await virtualMcpActions.create.mutateAsync({
                      title: "New Agent",
                      description: "Created from skill registry",
                      status: "active",
                      connections: [],
                      metadata: {
                        instructions: data.body || data.rawContent || "",
                        source: `github:${owner}/${repo}`,
                      },
                    });
                    toast.success("Agent created with skill");
                    setAgentPickerOpen(false);
                    navigate({
                      to: "/$org/$project/agents/$agentId",
                      params: {
                        org: org.slug,
                        project: ORG_ADMIN_PROJECT_SLUG,
                        agentId: result.id!,
                      },
                    });
                  }}
                >
                  <Plus className="size-4" />
                  Create Agent with this Skill
                </Button>
              </div>
            ) : (
              virtualMcps.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => handleAddToAgent(agent.id!)}
                  disabled={isInstalling}
                  className="flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-accent transition-colors text-left"
                >
                  <CubeOutline className="size-5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {agent.title}
                    </p>
                    {agent.description && (
                      <p className="text-xs text-muted-foreground truncate">
                        {agent.description}
                      </p>
                    )}
                  </div>
                  {isInstalling && (
                    <Loading01 className="size-4 animate-spin shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
