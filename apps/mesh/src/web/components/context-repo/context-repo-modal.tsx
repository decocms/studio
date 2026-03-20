/**
 * Context Repo Modal
 *
 * Flow: Setup (clone) → Pick Folders → Index → Configured view
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
  CheckCircle,
  Folder,
  GitBranch01,
  Loading01,
  RefreshCcw01,
  Trash01,
  XCircle,
} from "@untitledui/icons";
import { toast } from "sonner";
import {
  useContextRepo,
  useContextRepoSetup,
  useContextRepoSync,
  useContextRepoDisconnect,
  useContextRepoUpdateFolders,
} from "@/web/hooks/use-context-repo";

interface ContextRepoModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ContextRepoModal({
  open,
  onOpenChange,
}: ContextRepoModalProps) {
  const { gh, config, isLoading } = useContextRepo();
  // After setup (clone), we hold the folders for the picker step
  const [pendingFolders, setPendingFolders] = useState<Array<{
    name: string;
    fileCount: number;
    totalBytes: number;
  }> | null>(null);

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
        ) : config && config.fileCount > 0 ? (
          <ConfiguredView config={config} gh={gh} />
        ) : config && pendingFolders === null ? (
          // Cloned but not indexed yet — fetch folders from status
          <FolderPickerView
            folders={config.folders}
            onIndexed={() => setPendingFolders(null)}
          />
        ) : pendingFolders ? (
          <FolderPickerView
            folders={pendingFolders}
            onIndexed={() => setPendingFolders(null)}
          />
        ) : (
          <SetupView
            gh={gh}
            onCloned={(folders) => setPendingFolders(folders)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function GhStatusBadge({ gh }: { gh: { available: boolean; user?: string } }) {
  if (gh.available) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30 p-3 text-sm">
        <CheckCircle className="size-4 text-green-600 dark:text-green-400 shrink-0" />
        <span className="text-green-800 dark:text-green-300">
          GitHub CLI authenticated
          {gh.user && (
            <>
              {" "}
              as <span className="font-medium">{gh.user}</span>
            </>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-3 text-sm">
      <div className="flex items-center gap-2">
        <XCircle className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
        <span className="text-amber-800 dark:text-amber-300">
          GitHub CLI not authenticated
        </span>
      </div>
      <div className="text-xs text-amber-700 dark:text-amber-400 pl-6 space-y-1">
        <p>
          Install:{" "}
          <code className="bg-amber-100 dark:bg-amber-900/50 px-1 rounded">
            brew install gh
          </code>
        </p>
        <p>
          Login:{" "}
          <code className="bg-amber-100 dark:bg-amber-900/50 px-1 rounded">
            gh auth login
          </code>
        </p>
      </div>
    </div>
  );
}

interface FolderInfo {
  name: string;
  fileCount: number;
  totalBytes: number;
}

function SetupView({
  gh,
  onCloned,
}: {
  gh: { available: boolean; user?: string };
  onCloned: (folders: FolderInfo[]) => void;
}) {
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
      const result = await setupMutation.mutateAsync({ owner, repo, branch });
      // Extract folders from result
      const content = result?.content as Array<{
        type: string;
        text?: string;
      }>;
      const text = content?.find((c) => c.type === "text")?.text;
      const data = text ? JSON.parse(text) : null;
      const folders = (data?.folders as FolderInfo[]) ?? [];
      toast.success(`Cloned ${owner}/${repo} — now pick folders to index`);
      onCloned(folders);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to clone repository",
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

      <GhStatusBadge gh={gh} />

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Repository</label>
        <Input
          placeholder="owner/repo (e.g., decocms/context)"
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSetup()}
          disabled={!gh.available}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Branch</label>
        <Input
          placeholder="main"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          disabled={!gh.available}
        />
      </div>

      <Button
        onClick={handleSetup}
        disabled={setupMutation.isPending || !repoInput.trim() || !gh.available}
      >
        {setupMutation.isPending ? (
          <>
            <Loading01 className="size-4 animate-spin" />
            Cloning...
          </>
        ) : (
          "Clone Repository"
        )}
      </Button>

      {setupMutation.isError && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <p>
            {setupMutation.error instanceof Error
              ? setupMutation.error.message
              : "Clone failed"}
          </p>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FolderPickerView({
  folders,
  onIndexed,
}: {
  folders: FolderInfo[];
  onIndexed: () => void;
}) {
  const updateFoldersMutation = useContextRepoUpdateFolders();
  const folderNames = folders.map((f) => f.name);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(folderNames),
  );

  const allSelected = selected.size === folders.length;

  const selectedFiles = folders
    .filter((f) => selected.has(f.name))
    .reduce((sum, f) => sum + f.fileCount, 0);
  const selectedBytes = folders
    .filter((f) => selected.has(f.name))
    .reduce((sum, f) => sum + f.totalBytes, 0);

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(folderNames));
  };

  const handleIndex = async () => {
    const foldersToIndex = allSelected ? [] : [...selected];
    try {
      await updateFoldersMutation.mutateAsync(foldersToIndex);
      toast.success("Repository indexed");
      onIndexed();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Indexing failed");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Repository cloned. Select which folders to index for search.
      </p>

      <div className="flex items-center justify-between">
        <label className="text-sm font-medium flex items-center gap-2">
          <Folder className="size-4 text-muted-foreground" />
          Folders
        </label>
        <button
          type="button"
          onClick={toggleAll}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
      </div>

      <div className="rounded-lg border border-border max-h-64 overflow-y-auto divide-y divide-border">
        {folders.map((folder) => (
          <label
            key={folder.name}
            className="flex items-center gap-2 px-3 py-2 hover:bg-accent cursor-pointer text-sm"
          >
            <input
              type="checkbox"
              checked={selected.has(folder.name)}
              onChange={() => toggle(folder.name)}
              className="rounded border-border"
            />
            <span className="flex-1 min-w-0">
              {folder.name === "<root>" ? (
                <span className="text-muted-foreground italic">root files</span>
              ) : (
                <>
                  <span className="text-muted-foreground">/</span>
                  {folder.name}
                </>
              )}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
              {folder.fileCount} files
            </span>
            <span className="text-xs text-muted-foreground tabular-nums shrink-0 w-16 text-right">
              {formatSize(folder.totalBytes)}
            </span>
          </label>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {selectedFiles.toLocaleString()} files, {formatSize(selectedBytes)}{" "}
        selected
      </p>

      <Button
        onClick={handleIndex}
        disabled={updateFoldersMutation.isPending || selected.size === 0}
      >
        {updateFoldersMutation.isPending ? (
          <>
            <Loading01 className="size-4 animate-spin" />
            Indexing...
          </>
        ) : (
          `Index ${selected.size} folder${selected.size !== 1 ? "s" : ""}`
        )}
      </Button>
    </div>
  );
}

function ConfiguredView({
  config,
  gh,
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
    indexedFolders: string[] | null;
    folders: FolderInfo[];
  };
  gh: { available: boolean; user?: string };
}) {
  const syncMutation = useContextRepoSync();
  const disconnectMutation = useContextRepoDisconnect();
  const updateFoldersMutation = useContextRepoUpdateFolders();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const folderNames = config.folders.map((f) => f.name);
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(() => {
    if (config.indexedFolders && config.indexedFolders.length > 0) {
      return new Set(config.indexedFolders);
    }
    return new Set(folderNames);
  });

  const allSelected = selectedFolders.size === config.folders.length;

  const toggleFolder = (name: string) => {
    const next = new Set(selectedFolders);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelectedFolders(next);
  };

  const toggleAll = () => {
    setSelectedFolders(allSelected ? new Set() : new Set(folderNames));
  };

  const savedSet = new Set(
    config.indexedFolders && config.indexedFolders.length > 0
      ? config.indexedFolders
      : folderNames,
  );
  const selectionChanged =
    selectedFolders.size !== savedSet.size ||
    [...selectedFolders].some((f) => !savedSet.has(f));

  const handleSaveFolders = async () => {
    const folders = allSelected ? [] : [...selectedFolders];
    try {
      await updateFoldersMutation.mutateAsync(folders);
      toast.success("Indexed folders updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update folders");
    }
  };

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
      await disconnectMutation.mutateAsync();
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

      {/* GitHub auth status */}
      <GhStatusBadge gh={gh} />

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

      {/* Folder selection */}
      {config.folders.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium flex items-center gap-2">
              <Folder className="size-4 text-muted-foreground" />
              Indexed Folders
            </label>
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>
          <div className="rounded-lg border border-border max-h-48 overflow-y-auto divide-y divide-border">
            {config.folders.map((folder) => (
              <label
                key={folder.name}
                className="flex items-center gap-2 px-3 py-2 hover:bg-accent cursor-pointer text-sm"
              >
                <input
                  type="checkbox"
                  checked={selectedFolders.has(folder.name)}
                  onChange={() => toggleFolder(folder.name)}
                  className="rounded border-border"
                />
                <span className="flex-1 min-w-0">
                  {folder.name === "<root>" ? (
                    <span className="text-muted-foreground italic">
                      root files
                    </span>
                  ) : (
                    <>
                      <span className="text-muted-foreground">/</span>
                      {folder.name}
                    </>
                  )}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                  {folder.fileCount} files
                </span>
                <span className="text-xs text-muted-foreground tabular-nums shrink-0 w-16 text-right">
                  {formatSize(folder.totalBytes)}
                </span>
              </label>
            ))}
          </div>
          {selectionChanged && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveFolders}
              disabled={
                updateFoldersMutation.isPending || selectedFolders.size === 0
              }
            >
              {updateFoldersMutation.isPending ? (
                <>
                  <Loading01 className="size-4 animate-spin" />
                  Reindexing...
                </>
              ) : (
                `Reindex ${selectedFolders.size} folder${selectedFolders.size !== 1 ? "s" : ""}`
              )}
            </Button>
          )}
        </div>
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
