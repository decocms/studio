import { Page } from "@/web/components/page";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Check, Copy01 } from "@untitledui/icons";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

interface MCPServerDetailHeaderProps {
  breadcrumb?: ReactNode;
  shareUrl?: string;
}

export function MCPServerDetailHeader({
  breadcrumb,
  shareUrl,
}: MCPServerDetailHeaderProps) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    toast.success("Share link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Page.Header>
      <Page.Header.Left>{breadcrumb}</Page.Header.Left>
      {shareUrl && (
        <Page.Header.Right>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleShare}
                  className="gap-1.5 cursor-pointer"
                >
                  {copied ? (
                    <Check size={16} className="text-green-600" />
                  ) : (
                    <Copy01 size={16} />
                  )}
                  <span>{copied ? "Copied!" : "Share"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Copy a universal link anyone can use to find this MCP</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </Page.Header.Right>
      )}
    </Page.Header>
  );
}
