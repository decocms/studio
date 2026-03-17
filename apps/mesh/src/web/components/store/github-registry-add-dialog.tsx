/**
 * Dialog for adding a GitHub repository as a skill/agent registry.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Loading01 } from "@untitledui/icons";
import { extractGitHubRepo } from "@deco/ui/lib/github.ts";
import { useGitHubRegistrySync } from "@/web/hooks/use-github-registry";

interface GitHubRegistryAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (owner: string, repo: string) => void;
}

export function GitHubRegistryAddDialog({
  open,
  onOpenChange,
  onAdd,
}: GitHubRegistryAddDialogProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const syncMutation = useGitHubRegistrySync();

  const handleSubmit = async () => {
    setError(null);

    // Parse the input — accept "owner/repo" or full GitHub URL
    let owner: string | undefined;
    let repo: string | undefined;

    if (value.includes("/") && !value.includes("://")) {
      // Simple "owner/repo" format
      const parts = value.trim().split("/");
      owner = parts[0];
      repo = parts[1];
    } else {
      // Try URL parsing
      const parsed = extractGitHubRepo(value.trim());
      if (parsed) {
        owner = parsed.owner;
        repo = parsed.repo;
      }
    }

    if (!owner || !repo) {
      setError(
        'Enter a GitHub repository like "owner/repo" or a full GitHub URL',
      );
      return;
    }

    // Clone the repo
    try {
      await syncMutation.mutateAsync({ owner, repo });
      onAdd(owner, repo);
      setValue("");
      onOpenChange(false);
    } catch (e) {
      setError(
        `Failed to clone ${owner}/${repo}: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add GitHub Repository</DialogTitle>
          <DialogDescription>
            Add a GitHub repository to browse its skills and agents. The repo
            will be cloned locally for fast offline access.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 pt-2">
          <div className="flex flex-col gap-2">
            <Input
              placeholder="owner/repo or https://github.com/owner/repo"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
              }}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">GitHub Authentication</p>
            <p>
              Private repos use your local git credentials. Make sure{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                gh auth status
              </code>{" "}
              is configured, or that you have a GitHub MCP connection in your
              org.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={syncMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={syncMutation.isPending || !value.trim()}
            >
              {syncMutation.isPending ? (
                <>
                  <Loading01 className="size-4 animate-spin" />
                  Cloning...
                </>
              ) : (
                "Add Repository"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
