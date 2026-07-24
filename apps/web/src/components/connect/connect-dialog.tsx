/**
 * "Connect to Claude" modal (triggered from the sidebar footer).
 *
 * The org's MCP endpoint (`/api/<slug>/mcp/self`) exposes the org's control
 * surface — Library files, agents, connections. "Connecting Claude" is just
 * handing Claude that URL plus a credential. The primary path is designed to
 * "just work" with ZERO interactive auth: we mint a scoped API key and embed it
 * in the `claude mcp add … --header "Authorization: Bearer <key>"` command, so
 * Claude Code connects on the first request — no `/mcp`, no browser login.
 *
 * Claude Desktop / claude.ai can't take a custom header, so those use the URL +
 * OAuth connector flow. The full Connect settings page (Cursor, Codex, OAuth,
 * key management) stays reachable via the footer link.
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
import { useProjectContext } from "@/sdk";
import {
  ArrowRight,
  Check,
  Copy01,
  FolderCode,
  Link01,
  ShieldTick,
  Terminal,
} from "@untitledui/icons";
import { track } from "@/lib/posthog-client";
import { claudeCodeCommandWithKey, mcpUrl } from "@/components/connect/mcp-url";
import { useCreateApiKey } from "@/hooks/use-api-keys";

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
    <div className="flex flex-col gap-4 min-w-0">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2.5">
          <span className="size-8 rounded-lg bg-special/15 text-special flex items-center justify-center shrink-0">
            <Link01 size={17} />
          </span>
          Connect {org.name} to Claude
        </DialogTitle>
        <DialogDescription>
          Hand Claude this org's MCP endpoint. Once linked, Claude can:
        </DialogDescription>
      </DialogHeader>

      <ul className="flex flex-col gap-2 text-sm">
        {CAPABILITIES.map((cap) => (
          <li key={cap} className="flex items-center gap-2.5">
            <span className="size-4 rounded-full bg-special/15 text-special flex items-center justify-center shrink-0">
              <Check size={11} strokeWidth={3} />
            </span>
            <span className="text-foreground">{cap}</span>
          </li>
        ))}
      </ul>

      {/* Claude Code — one command, no login. We mint a scoped token and embed
          it so `claude mcp add` connects on the first request. */}
      <section className="rounded-xl border border-border bg-muted/30 p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Terminal size={15} className="text-muted-foreground" />
          Claude Code
          <span className="ml-auto text-[11px] font-medium text-special uppercase tracking-wide">
            Recommended
          </span>
        </div>

        {command ? (
          <>
            <div className="rounded-lg border border-border bg-background p-3 max-h-32 overflow-y-auto">
              <code className="text-xs leading-relaxed break-all font-mono text-foreground/90 whitespace-pre-wrap">
                {command}
              </code>
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
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
              <ShieldTick size={14} className="text-warning shrink-0 mt-0.5" />
              <p className="text-xs leading-relaxed text-foreground/80">
                No login step — this command embeds a{" "}
                <span className="font-medium text-foreground">
                  full-access token
                </span>
                . Treat it like a password; revoke it any time in Settings →
                Connect.
              </p>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-muted-foreground">
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
      </section>

      {/* Claude Desktop / claude.ai — paste the URL as a custom connector. */}
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <FolderCode size={15} className="text-muted-foreground" />
          Claude Desktop or claude.ai
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Add a custom connector in Settings → Connectors and paste this URL.
          Claude signs in with OAuth on first use.
        </p>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 pl-3 pr-1.5 py-1.5 min-w-0">
          <code className="text-xs flex-1 min-w-0 truncate font-mono text-foreground/90">
            {url}
          </code>
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
      </section>

      <div className="flex items-center border-t border-border pt-3">
        <Button asChild variant="link" size="sm" className="px-0 text-xs gap-1">
          <Link
            to="/$org/settings/connect"
            params={{ org: org.slug }}
            onClick={onClose}
          >
            More clients &amp; API keys <ArrowRight size={12} />
          </Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * Controlled "Connect to Claude" dialog. The trigger lives elsewhere (sidebar
 * footer) and drives `open`; the body remounts on each open so the generated
 * command/state resets cleanly.
 */
export function ConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-4">
        <ConnectDialogBody onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
