/**
 * Context Repo Modal
 *
 * Modal for setting up and managing the GitHub context repository.
 * Three states: setup instructions, repo form, or status view.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  AlertCircle,
  Check,
  GitBranch01,
  Loading01,
  RefreshCcw01,
  Trash01,
} from "@untitledui/icons";
import { toast } from "sonner";
import {
  useContextRepo,
  useContextRepoSetup,
  useContextRepoSync,
  useContextRepoDisconnect,
} from "@/web/hooks/use-context-repo";

interface ContextRepoModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ContextRepoModal({
  open,
  onOpenChange,
}: ContextRepoModalProps) {
  const contextRepo = useContextRepo();
  const config = contextRepo.config;
  const isLoading = contextRepo.isLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch01 className="size-5" />
            Context Repo
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loading01 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : config ? (
          <ConfiguredView config={config} />
        ) : (
          <SetupView onSuccess={() => {}} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SetupView({ onSuccess }: { onSuccess: () => void }) {
  const [repoInput, setRepoInput] = useState("");
  const [branch, setBranch] = useState("main");
  const setupMutation = useContextRepoSetup();

  const handleSetup = async () => {
    const parts = repoInput.trim().split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      toast.error("Enter a valid owner/repo (e.g., decocms/context)");
      return;
    }
    const [owner, repo] = parts;

    try {
      await setupMutation.mutateAsync({ owner, repo, branch });
      toast.success(`Connected ${owner}/${repo} as context repo`);
      onSuccess();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to set up context repo",
      );
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Connect a GitHub repository as the shared context for this organization.
        All files will be indexed for search, skills in{" "}
        <code className="text-xs bg-muted px-1 rounded">skills/</code> will be
        discoverable by agents, and issues can be used for agent communication.
      </p>

      <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground mb-1">Prerequisites</p>
        <p>
          Install GitHub CLI:{" "}
          <code className="bg-muted px-1 rounded">brew install gh</code>
        </p>
        <p>
          Authenticate:{" "}
          <code className="bg-muted px-1 rounded">gh auth login</code>
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Repository</label>
        <Input
          placeholder="owner/repo (e.g., decocms/context)"
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSetup()}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Branch</label>
        <Input
          placeholder="main"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
      </div>

      <Button
        onClick={handleSetup}
        disabled={setupMutation.isPending || !repoInput.trim()}
      >
        {setupMutation.isPending ? (
          <>
            <Loading01 className="size-4 animate-spin" />
            Cloning & indexing...
          </>
        ) : (
          "Connect"
        )}
      </Button>

      {setupMutation.isError && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <p>
            {setupMutation.error instanceof Error
              ? setupMutation.error.message
              : "Setup failed"}
          </p>
        </div>
      )}
    </div>
  );
}

function ConfiguredView({
  config,
}: {
  config: {
    connectionId: string;
    owner: string;
    repo: string;
    branch: string;
    lastSyncedCommit: string | null;
    fileCount: number;
    indexSizeBytes: number;
    lastSyncedAt: string | null;
  };
}) {
  const syncMutation = useContextRepoSync();
  const disconnectMutation = useContextRepoDisconnect();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const handleSync = async () => {
    try {
      await syncMutation.mutateAsync();
      toast.success("Context repo synced");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync(config.connectionId);
      toast.success("Context repo disconnected");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Disconnect failed");
    }
  };

  const sizeKB = Math.round(config.indexSizeBytes / 1024);
  const sizeMB = (config.indexSizeBytes / (1024 * 1024)).toFixed(1);
  const sizeDisplay =
    config.indexSizeBytes > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

  return (
    <div className="flex flex-col gap-4">
      {/* Repo info */}
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
          <GitBranch01 className="size-5 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium">
            {config.owner}/{config.repo}
          </p>
          <p className="text-xs text-muted-foreground">
            branch: {config.branch}
          </p>
        </div>
        <Check className="ml-auto size-4 text-green-500" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Files</p>
          <p className="text-lg font-semibold">
            {config.fileCount.toLocaleString()}
          </p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Index Size</p>
          <p className="text-lg font-semibold">{sizeDisplay}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Last Synced</p>
          <p className="text-sm font-medium">
            {config.lastSyncedAt
              ? new Date(config.lastSyncedAt).toLocaleDateString()
              : "Never"}
          </p>
        </div>
      </div>

      {config.lastSyncedCommit && (
        <p className="text-xs text-muted-foreground">
          HEAD:{" "}
          <code className="bg-muted px-1 rounded">
            {config.lastSyncedCommit.slice(0, 8)}
          </code>
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={handleSync}
          disabled={syncMutation.isPending}
        >
          {syncMutation.isPending ? (
            <Loading01 className="size-4 animate-spin" />
          ) : (
            <RefreshCcw01 className="size-4" />
          )}
          Sync Now
        </Button>

        {confirmDisconnect ? (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-muted-foreground">Are you sure?</span>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDisconnect}
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending ? (
                <Loading01 className="size-4 animate-spin" />
              ) : (
                "Yes, disconnect"
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDisconnect(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-muted-foreground"
            onClick={() => setConfirmDisconnect(true)}
          >
            <Trash01 className="size-4" />
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}
