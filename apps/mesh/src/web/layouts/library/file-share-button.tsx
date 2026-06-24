/**
 * Share controls for Library files and folders — copy the proxy link and flip
 * visibility between org-only and public.
 *
 * A public file serves to anyone with its link; a public folder publishes its
 * whole subtree (the read proxy inherits from public ancestor folders), so a
 * page and its co-located assets go public together. Toggling never moves
 * anything — the same `/api/:org/fs/:volume/read?path=…` link just changes who
 * it works for.
 *
 * Three surfaces share one body (`ShareControls`): `FileShareButton` (the
 * preview-toolbar popover) and `ShareDialog` (opened from Library cards).
 */

import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Check, Copy01, Globe01, Lock01, Share07 } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { useOrgFsSetPublic, useOrgFsStat } from "@/web/hooks/use-org-fs";

export interface ShareTarget {
  volume: string;
  /** In-volume path of the file or folder. */
  path: string;
  kind: "file" | "dir";
  /** Last-known public state — seeds the toggle until the live stat loads. */
  readPublic: boolean;
  /** Absolute proxy link to copy. Files only; folders have no single URL. */
  url?: string;
}

/** The shared body: a visibility switch and (for files) a copy-link row. */
function ShareControls({ volume, path, kind, readPublic, url }: ShareTarget) {
  const setPublic = useOrgFsSetPublic(volume);
  // Read live state so the switch reflects the optimistic toggle immediately
  // (the mutation writes this exact stat key), falling back to the seed value
  // while it loads.
  const { data: entry } = useOrgFsStat(volume, path);
  const isPublic = entry?.readPublic ?? readPublic;
  const [copied, setCopied] = useState(false);
  const isDir = kind === "dir";
  const subject = isDir ? "folder" : "file";

  const handleToggle = (next: boolean) => {
    setPublic.mutate(
      { path, public: next },
      {
        onSuccess: () =>
          toast.success(
            next
              ? isDir
                ? "Anyone with the link can now view files in this folder"
                : "Anyone with the link can now view this file"
              : `This ${subject} is now org-only`,
          ),
        onError: (err) =>
          toast.error(
            err instanceof Error ? err.message : "Failed to update sharing",
          ),
      },
    );
  };

  const handleCopy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {isPublic ? <Globe01 size={16} /> : <Lock01 size={16} />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium text-foreground">
            {isPublic ? "Anyone with the link" : "Only your organization"}
          </span>
          <span className="text-xs text-muted-foreground">
            {isPublic
              ? isDir
                ? "Anyone on the internet can view files in this folder via their link."
                : "Anyone on the internet with the link can view this file."
              : `Only members of your organization can open ${
                  isDir ? "these files" : "this link"
                }.`}
          </span>
        </div>
        <Switch
          checked={isPublic}
          disabled={setPublic.isPending}
          onCheckedChange={handleToggle}
          aria-label={`Make ${subject} public`}
        />
      </div>
      {url && (
        <div className="flex items-center gap-2 rounded-md border border-input bg-muted/50 px-2 py-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {url}
          </code>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={handleCopy}
            aria-label="Copy link"
          >
            {copied ? (
              <Check size={12} className="text-green-600" />
            ) : (
              <Copy01 size={12} />
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Preview-toolbar popover trigger (files). */
export function FileShareButton({
  volume,
  path,
  readPublic,
  url,
}: {
  volume: string;
  path: string;
  readPublic: boolean;
  url: string;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Share">
              <Share07 size={14} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Share</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-3">
        <ShareControls
          volume={volume}
          path={path}
          kind="file"
          readPublic={readPublic}
          url={url}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Modal share surface opened from Library cards (files and folders). */
export function ShareDialog({
  target,
  onOpenChange,
}: {
  target: ShareTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Share {target?.kind === "dir" ? "folder" : "file"}
          </DialogTitle>
        </DialogHeader>
        {target && <ShareControls {...target} />}
      </DialogContent>
    </Dialog>
  );
}
