import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronUp,
  ChevronDown,
  GitCommit as GitCommitIcon,
} from "lucide-react";
import { Button } from "@deco/ui/components/button.tsx";
import { toast } from "sonner";
import type { GenericToolCaller } from "../lib/page-api";
import {
  hasBashTool,
  gitStatus,
  gitLog,
  gitShow,
  gitCheckout,
  gitCommit,
  type GitCommit,
} from "../lib/git-api";
import { QUERY_KEYS } from "../lib/query-keys";
import { CommitDialog } from "./commit-dialog";
import { RevertDialog } from "./revert-dialog";

interface FooterBarProps {
  pageId: string;
  projectId: string;
  toolCaller: GenericToolCaller;
  connectionTools: Array<{ name: string }> | null | undefined;
  onPageReverted: () => void;
}

export function FooterBar({
  pageId,
  projectId,
  toolCaller,
  connectionTools,
  onPageReverted,
}: FooterBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [generatedMessage, setGeneratedMessage] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [expandedCommitHash, setExpandedCommitHash] = useState<string | null>(
    null,
  );
  const [diffContent, setDiffContent] = useState<string>("");
  const [revertTarget, setRevertTarget] = useState<GitCommit | null>(null);
  const queryClient = useQueryClient();

  // Hide git UX if no bash tool on connection
  if (!hasBashTool(connectionTools)) return null;

  const { data: statusResult } = useQuery({
    queryKey: QUERY_KEYS.gitStatus(projectId, pageId),
    queryFn: () => gitStatus(toolCaller, pageId),
    refetchInterval: 5000, // Poll every 5s for changes
  });

  const { data: commits = [] } = useQuery({
    queryKey: QUERY_KEYS.gitLog(projectId, pageId),
    queryFn: () => gitLog(toolCaller, pageId),
    enabled: expanded,
  });

  const hasPendingChanges = statusResult?.status !== "clean";
  const statusBadge = hasPendingChanges ? statusResult?.status : null;

  const handleOpenCommit = async () => {
    setIsGenerating(true);
    setGeneratedMessage("");
    setCommitDialogOpen(true);
    try {
      // Get diff for commit message generation
      const diffResult = (await toolCaller("bash", {
        command: `git diff HEAD .deco/pages/${pageId}.json`,
      })) as { stdout: string };
      const diff = diffResult.stdout;

      // Call server route for Claude-generated message
      const response = await fetch("/api/plugins/site-editor/commit-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff }),
      });
      const data = (await response.json()) as { message?: string };
      setGeneratedMessage(data.message ?? "");
    } catch {
      setGeneratedMessage("Update site page");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCommit = async (message: string) => {
    await gitCommit(toolCaller, message);
    queryClient.invalidateQueries({
      queryKey: QUERY_KEYS.gitStatus(projectId, pageId),
    });
    queryClient.invalidateQueries({
      queryKey: QUERY_KEYS.gitLog(projectId, pageId),
    });
    toast.success("Changes committed");
  };

  const handleExpandCommit = async (commit: GitCommit) => {
    if (expandedCommitHash === commit.hash) {
      setExpandedCommitHash(null);
      return;
    }
    setExpandedCommitHash(commit.hash);
    const content = await gitShow(toolCaller, commit.hash, pageId);
    setDiffContent(content);
  };

  const handleRevert = async () => {
    if (!revertTarget) return;
    await gitCheckout(toolCaller, revertTarget.hash, pageId);
    queryClient.invalidateQueries({
      queryKey: QUERY_KEYS.page(projectId, pageId),
    });
    queryClient.invalidateQueries({
      queryKey: QUERY_KEYS.gitStatus(projectId, pageId),
    });
    toast.success("Page reverted");
    onPageReverted();
  };

  return (
    <div className="border-t bg-background">
      {/* Footer header bar */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted/30 select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <GitCommitIcon size={12} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground flex-1">
          {hasPendingChanges ? (
            <span>
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${
                  statusBadge === "A"
                    ? "bg-green-500"
                    : statusBadge === "D"
                      ? "bg-red-500"
                      : "bg-yellow-500"
                }`}
              />
              Pending changes
            </span>
          ) : (
            "No pending changes"
          )}
        </span>
        {hasPendingChanges && (
          <Button
            variant="outline"
            size="sm"
            className="h-5 text-xs px-2"
            onClick={(e) => {
              e.stopPropagation();
              void handleOpenCommit();
            }}
          >
            Commit
          </Button>
        )}
        {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </div>

      {/* Expanded footer panel */}
      {expanded && (
        <div className="border-t max-h-64 overflow-y-auto">
          {commits.length === 0 ? (
            <p className="text-xs text-muted-foreground px-3 py-2">
              No commit history for this page.
            </p>
          ) : (
            <ul className="divide-y">
              {commits.map((commit) => (
                <li key={commit.hash}>
                  <div
                    className="flex items-start gap-2 px-3 py-2 hover:bg-muted/30 cursor-pointer"
                    onClick={() => void handleExpandCommit(commit)}
                  >
                    <GitCommitIcon
                      size={12}
                      className="mt-0.5 text-muted-foreground flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {commit.message}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {commit.author} ·{" "}
                        {new Date(commit.date).toLocaleDateString()} ·{" "}
                        <code className="bg-muted px-0.5 rounded">
                          {commit.hash.slice(0, 7)}
                        </code>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 text-xs px-1.5 flex-shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRevertTarget(commit);
                      }}
                    >
                      Revert
                    </Button>
                  </div>

                  {/* Inline diff panel */}
                  {expandedCommitHash === commit.hash && (
                    <div className="bg-muted/20 px-3 py-2 border-t">
                      <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-40 text-muted-foreground">
                        {diffContent || "Loading diff..."}
                      </pre>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <CommitDialog
        open={commitDialogOpen}
        onClose={() => {
          setCommitDialogOpen(false);
          setGeneratedMessage("");
        }}
        onConfirm={handleCommit}
        generatedMessage={generatedMessage}
        isGenerating={isGenerating}
      />

      <RevertDialog
        open={!!revertTarget}
        onClose={() => setRevertTarget(null)}
        onConfirm={handleRevert}
        commit={revertTarget}
      />
    </div>
  );
}
