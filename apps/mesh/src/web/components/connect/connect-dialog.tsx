/**
 * Topbar "Link" button + one-command "Connect to Claude" modal.
 *
 * The org's unified MCP endpoint (`/api/<slug>/mcp`) already exposes every
 * connection enabled in the org — the library filesystem, your agents, and any
 * MCP tool. So "connecting Claude" is just handing Claude that one URL plus a
 * credential. The primary path here is designed to "just work" with ZERO
 * interactive auth: we mint a scoped API key and embed it in the
 * `claude mcp add … --header "Authorization: Bearer <key>"` command, so Claude
 * Code connects on the first request — no `/mcp`, no browser login.
 *
 * Claude Desktop / claude.ai can't take a custom header, so those still use the
 * URL + OAuth connector flow. The full Connect settings page (Cursor, Codex,
 * OAuth, key management) stays reachable via the footer link.
 */

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@deco/ui/components/alert.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { useCopy } from "@deco/ui/hooks/use-copy.ts";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy01,
  FolderCode,
  Link01,
  Terminal,
  Zap,
} from "@untitledui/icons";
import { track } from "@/web/lib/posthog-client";
import {
  claudeCodeCommandWithKey,
  mcpUrl,
} from "@/web/components/connect/mcp-url";
import { useCreateApiKey } from "@/web/hooks/use-api-keys";

const CAPABILITIES = [
  "Browse and edit your Library files",
  "Run your agents",
  "Enable and call any MCP tool in this org",
];

const KEY_NAME_PREFIX = "Connect: ";

function hostnameLabel(): string {
  if (typeof window === "undefined") return "unknown host";
  return window.location.hostname;
}

function ConnectDialogBody({ onClose }: { onClose: () => void }) {
  const { org } = useProjectContext();
  const url = mcpUrl(org.slug);

  const createKey = useCreateApiKey();
  const [command, setCommand] = useState<string | null>(null);
  const commandCopy = useCopy();
  const urlCopy = useCopy();

  const handleGenerate = () => {
    createKey.mutate(
      {
        name: `${KEY_NAME_PREFIX}Claude Code on ${hostnameLabel()}`,
        permissions: { "*": ["*"] },
      },
      {
        onSuccess: (key) => {
          const cmd = claudeCodeCommandWithKey(org.slug, key.key);
          setCommand(cmd);
          track("connect_studio_generate", { target: "claude-code" });
          // Best-effort auto-copy so it's truly one click; the visible copy
          // button is the reliable fallback if the browser blocks it.
          navigator.clipboard?.writeText(cmd).then(
            () => toast.success("Command copied — paste it in your terminal"),
            () => toast.success("Command ready — copy it below"),
          );
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="size-7 rounded-md bg-special/15 text-special flex items-center justify-center shrink-0">
            <Link01 size={16} />
          </span>
          Connect {org.name} to Claude
        </DialogTitle>
        <DialogDescription>
          Hand Claude this org's unified MCP endpoint. Once linked, Claude can:
        </DialogDescription>
      </DialogHeader>

      <ul className="flex flex-col gap-1.5 text-sm">
        {CAPABILITIES.map((cap) => (
          <li key={cap} className="flex items-center gap-2">
            <Zap size={14} className="text-special shrink-0" />
            <span>{cap}</span>
          </li>
        ))}
      </ul>

      {/* Claude Code — one command, no login. We mint a scoped token and embed
          it so `claude mcp add` connects on the first request. */}
      <div className="rounded-lg border border-border p-3 flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Terminal size={15} className="text-muted-foreground" />
          Claude Code
        </div>

        {command ? (
          <>
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
              <code className="text-xs break-all font-mono">{command}</code>
            </div>
            <Button
              size="sm"
              className="gap-1.5 self-start"
              onClick={() => {
                commandCopy.handleCopy(command);
                track("connect_studio_copy", { target: "claude-code" });
                toast.success("Command copied — paste it in your terminal");
              }}
            >
              {commandCopy.copied ? <Check size={14} /> : <Copy01 size={14} />}
              {commandCopy.copied ? "Copied" : "Copy command"}
            </Button>
            <Alert variant="warning" className="text-xs">
              <AlertTriangle />
              <AlertDescription>
                Runs with no login step — the command embeds a full-access token
                for this org. Treat it like a password; revoke it any time in
                Settings → Connect.
              </AlertDescription>
            </Alert>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              One command, no browser login. We'll mint a scoped access token
              and embed it so Claude Code connects instantly.
            </p>
            <Button
              size="sm"
              className="gap-1.5 self-start"
              disabled={createKey.isPending}
              onClick={handleGenerate}
            >
              <Terminal size={14} />
              {createKey.isPending ? "Generating…" : "Generate connect command"}
            </Button>
          </>
        )}
      </div>

      {/* Claude Desktop / claude.ai — paste the URL as a custom connector. */}
      <div className="rounded-lg border border-border p-3 flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FolderCode size={15} className="text-muted-foreground" />
          Claude Desktop or claude.ai
        </div>
        <p className="text-xs text-muted-foreground">
          Add a custom connector in Settings → Connectors and paste this URL.
          Claude signs in with OAuth on first use.
        </p>
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5">
          <code className="text-xs flex-1 truncate font-mono">{url}</code>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="Copy URL"
            onClick={() => {
              urlCopy.handleCopy(url);
              track("connect_studio_copy", { target: "claude-connector" });
            }}
          >
            {urlCopy.copied ? <Check size={14} /> : <Copy01 size={14} />}
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <Button asChild variant="link" size="sm" className="px-0 text-xs gap-1">
          <Link
            to="/$org/settings/connect"
            params={{ org: org.slug }}
            onClick={onClose}
          >
            More clients & API keys <ArrowRight size={12} />
          </Link>
        </Button>
      </div>
    </>
  );
}

/**
 * The "LINK" affordance for the app topbar. Self-contained: owns its own open
 * state so it can be dropped into any header slot.
 */
export function ConnectLinkButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => {
          track("connect_studio_opened", { source: "topbar" });
          setOpen(true);
        }}
      >
        <Link01 size={14} />
        Link
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-4">
          <ConnectDialogBody onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
