/**
 * Webhook Secret Dialog
 *
 * Shows the URL + plaintext token for a webhook trigger one time. Used
 * immediately after creation and after rotation. The token is not stored
 * in the database in plaintext, so it cannot be retrieved later — the
 * dialog warns the user to copy it now.
 */

import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Copy01 } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";

export function WebhookSecretDialog({
  open,
  onOpenChange,
  url,
  token,
  title = "Webhook ready",
  description = "Send a POST to this URL with the bearer token to fire the automation. The token is shown once — copy it now.",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string | null;
  token: string | null;
  title?: string;
  description?: string;
}) {
  const [copied, setCopied] = useState<"url" | "token" | "curl" | null>(null);

  const copy = async (value: string, kind: "url" | "token" | "curl") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      toast.success("Copied");
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("Failed to copy");
    }
  };

  const curl =
    url && token
      ? `curl -X POST "${url}" \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"hello":"world"}'`
      : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {url && token ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted-foreground">
                URL
              </span>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-muted rounded-md px-2 py-1.5 truncate">
                  {url}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copy(url, "url")}
                >
                  <Copy01 size={13} />
                  {copied === "url" ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted-foreground">
                Token (shown once)
              </span>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-muted rounded-md px-2 py-1.5 truncate">
                  {token}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copy(token, "token")}
                >
                  <Copy01 size={13} />
                  {copied === "token" ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted-foreground">
                Example
              </span>
              <pre className="text-xs font-mono bg-muted rounded-md px-2 py-1.5 whitespace-pre-wrap break-all">
                {curl}
              </pre>
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() => copy(curl, "curl")}
              >
                <Copy01 size={13} />
                {copied === "curl" ? "Copied" : "Copy curl"}
              </Button>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
