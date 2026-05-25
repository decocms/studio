/**
 * Webhook Secret Dialog
 *
 * Shows the URL + plaintext token for a webhook trigger one time. Used
 * immediately after creation and after rotation. The token is not stored
 * in the database in plaintext, so it cannot be retrieved later — the
 * dialog warns the user to copy it now.
 */

import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Tabs, TabsList, TabsTrigger } from "@deco/ui/components/tabs.tsx";
import { Copy01 } from "@untitledui/icons";
import { useId, useState } from "react";
import { toast } from "sonner";
import { MonacoCodeEditor } from "../details/workflow/components/monaco-editor";

type ExampleKind = "curl" | "fetch";
type AuthPlacement = "header" | "url";

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
  const [copied, setCopied] = useState<"url" | "token" | "example" | null>(
    null,
  );
  const [example, setExample] = useState<ExampleKind>("curl");
  const [authPlacement, setAuthPlacement] = useState<AuthPlacement>("header");
  const tokenInUrlId = useId();

  const copy = async (value: string, kind: "url" | "token" | "example") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      toast.success("Copied");
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("Failed to copy");
    }
  };

  // When the token lives in the URL path, the URL the caller copies includes
  // it (`/webhooks/<triggerId>/<token>`) and the Authorization header is
  // omitted. When in the header, the URL stays bare.
  const effectiveUrl =
    url && token && authPlacement === "url"
      ? `${url.replace(/\/$/, "")}/${token}`
      : (url ?? "");

  const curl =
    url && token
      ? authPlacement === "header"
        ? `curl -X POST "${effectiveUrl}" \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"hello":"world"}'`
        : `curl -X POST "${effectiveUrl}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"hello":"world"}'`
      : "";

  const fetchSnippet =
    url && token
      ? authPlacement === "header"
        ? `await fetch("${effectiveUrl}", {\n  method: "POST",\n  headers: {\n    Authorization: "Bearer ${token}",\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ hello: "world" }),\n});`
        : `await fetch("${effectiveUrl}", {\n  method: "POST",\n  headers: {\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ hello: "world" }),\n});`
      : "";

  const exampleSnippet = example === "curl" ? curl : fetchSnippet;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {url && token ? (
          <div className="flex flex-col gap-3 min-w-0">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted-foreground">
                URL
              </span>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 text-xs font-mono bg-muted rounded-md px-2 py-1.5 truncate">
                  {effectiveUrl}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copy(effectiveUrl, "url")}
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
                <code className="flex-1 min-w-0 text-xs font-mono bg-muted rounded-md px-2 py-1.5 truncate">
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

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-muted-foreground">
                Snippet
              </span>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Tabs
                    value={example}
                    onValueChange={(v) => setExample(v as ExampleKind)}
                  >
                    <TabsList className="h-8 p-[2px]">
                      <TabsTrigger value="curl" className="h-7 px-2.5 text-xs">
                        curl
                      </TabsTrigger>
                      <TabsTrigger value="fetch" className="h-7 px-2.5 text-xs">
                        fetch
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <label
                    htmlFor={tokenInUrlId}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
                  >
                    <Checkbox
                      id={tokenInUrlId}
                      checked={authPlacement === "url"}
                      onCheckedChange={(checked) =>
                        setAuthPlacement(checked ? "url" : "header")
                      }
                    />
                    Token in URL
                  </label>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copy(exampleSnippet, "example")}
                >
                  <Copy01 size={13} />
                  {copied === "example" ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="rounded-md border overflow-hidden min-w-0">
                <MonacoCodeEditor
                  code={exampleSnippet}
                  language={example === "curl" ? "shell" : "typescript"}
                  readOnly
                  disableDiagnostics
                  height={180}
                />
              </div>
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
