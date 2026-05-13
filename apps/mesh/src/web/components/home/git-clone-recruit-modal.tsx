import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { useVirtualMCPActions, useProjectContext } from "@decocms/mesh-sdk";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent.ts";
import { track } from "@/web/lib/posthog-client";
import { GitBranch01 } from "@untitledui/icons";

interface GitCloneRecruitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function deriveTitle(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 1] ?? "New Agent";
    return parts[0] ?? "New Agent";
  } catch {
    return "New Agent";
  }
}

function CloneContent({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const actions = useVirtualMCPActions();
  const { org } = useProjectContext();
  const navigateToAgent = useNavigateToAgent();

  const isValidUrl = (value: string) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  };

  const handleSubmit = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError("Please enter a git URL.");
      return;
    }
    if (!isValidUrl(trimmed)) {
      setError("Enter a valid URL, e.g. https://github.com/owner/repo.git");
      return;
    }
    setError(null);

    track("home_git_clone_submitted", { org: org.slug });

    const title = deriveTitle(trimmed);
    const virtualMcp = await actions.create.mutateAsync({
      title,
      description: null,
      status: "active",
      pinned: true,
      connections: [],
      metadata: {
        cloneUrl: trimmed,
        instructions: null,
      },
    });

    onOpenChange(false);
    navigateToAgent(virtualMcp.id!);
  };

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-muted-foreground">
          Paste any public git URL. The repo will be cloned into a sandbox so
          you can start coding right away — no GitHub account needed.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="clone-url"
          className="text-sm font-medium text-foreground"
        >
          Repository URL
        </label>
        <Input
          id="clone-url"
          type="url"
          placeholder="https://github.com/owner/repo.git"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSubmit();
          }}
          autoFocus
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={actions.create.isPending}
        >
          Cancel
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          disabled={actions.create.isPending}
        >
          {actions.create.isPending ? "Creating..." : "Clone & open"}
        </Button>
      </div>
    </div>
  );
}

export function GitCloneRecruitModal({
  open,
  onOpenChange,
}: GitCloneRecruitModalProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle className="flex items-center gap-2">
              <GitBranch01 size={16} />
              Clone from URL
            </DrawerTitle>
          </DrawerHeader>
          <CloneContent onOpenChange={onOpenChange} />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle className="flex items-center gap-2">
            <GitBranch01 size={16} />
            Clone from URL
          </DialogTitle>
        </DialogHeader>
        <CloneContent onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}
