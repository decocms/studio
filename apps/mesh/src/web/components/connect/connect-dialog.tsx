/**
 * Topbar "LINK" button + one-click "Connect to Claude" modal.
 *
 * The org's unified MCP endpoint (`/api/<slug>/mcp`) already exposes every
 * connection enabled in the org — the library filesystem, your agents, and any
 * MCP tool — behind OAuth 2.1. So "connecting Claude" is just handing Claude
 * that one URL. This dialog does exactly that with a single primary action:
 *   • Claude Code  → copy the `claude mcp add …` one-liner (paste in a terminal)
 *   • Claude Desktop / claude.ai → copy the URL to add as a custom connector
 *
 * The full Connect settings page (Cursor, Codex, API keys, key management)
 * stays reachable via the footer link for power users.
 */

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
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
  ArrowRight,
  Check,
  Copy01,
  FolderCode,
  Link01,
  Terminal,
  Zap,
} from "@untitledui/icons";
import { track } from "@/web/lib/posthog-client";
import { claudeCodeCommand, mcpUrl } from "@/web/components/connect/mcp-url";

const CAPABILITIES = [
  "Browse and edit your Library files",
  "Run your agents",
  "Enable and call any MCP tool in this org",
];

function ConnectDialogBody({ onClose }: { onClose: () => void }) {
  const { org } = useProjectContext();
  const url = mcpUrl(org.slug);
  const command = claudeCodeCommand(org.slug);

  const commandCopy = useCopy();
  const urlCopy = useCopy();

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

      {/* Claude Code — the true one-click: copy, paste, done. */}
      <div className="rounded-lg border border-border p-3 flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Terminal size={15} className="text-muted-foreground" />
          Claude Code
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
          <code className="text-xs flex-1 truncate font-mono">{command}</code>
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
          {commandCopy.copied ? "Copied" : "Copy connect command"}
        </Button>
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
        LINK
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-4">
          <ConnectDialogBody onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
