/**
 * Share control for a Library file preview. A popover with two things: copy the
 * proxy link, and a switch that flips the file between org-only and public.
 *
 * Both states copy the SAME link (`/api/:org/fs/:volume/read?path=…`) — the
 * switch changes who that link works for, not the link itself. Org-only: only
 * members can open it. Public: anyone on the internet with the link can.
 */

import { Button } from "@deco/ui/components/button.tsx";
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
import { useOrgFsSetPublic } from "@/web/hooks/use-org-fs";

export function FileShareButton({
  volume,
  path,
  readPublic,
  url,
}: {
  volume: string;
  /** In-volume path — must match the `stat` query's path for cache sync. */
  path: string;
  readPublic: boolean;
  /** Absolute proxy link to copy (origin + /read URL). */
  url: string;
}) {
  const setPublic = useOrgFsSetPublic(volume);
  const [copied, setCopied] = useState(false);

  const handleToggle = (next: boolean) => {
    setPublic.mutate(
      { path, public: next },
      {
        onSuccess: () =>
          toast.success(
            next
              ? "Anyone with the link can now view this file"
              : "File is now org-only",
          ),
        onError: (err) =>
          toast.error(
            err instanceof Error ? err.message : "Failed to update sharing",
          ),
      },
    );
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

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
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {readPublic ? <Globe01 size={16} /> : <Lock01 size={16} />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium text-foreground">
                {readPublic ? "Anyone with the link" : "Only your organization"}
              </span>
              <span className="text-xs text-muted-foreground">
                {readPublic
                  ? "Anyone on the internet with the link can view this file."
                  : "Only members of your organization can open this link."}
              </span>
            </div>
            <Switch
              checked={readPublic}
              disabled={setPublic.isPending}
              onCheckedChange={handleToggle}
              aria-label="Make file public"
            />
          </div>
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
        </div>
      </PopoverContent>
    </Popover>
  );
}
