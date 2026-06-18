import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Check, Copy01 } from "@untitledui/icons";
import { useState, type ReactNode } from "react";
import type { Capability } from "@/links/protocol";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { ClaudeCodeIcon, CodexIcon } from "./agent-icons";

const INSTALL_SNIPPET = "bunx decocms link";

interface LocalAgent {
  capability: Capability;
  label: string;
  description: string;
  icon: ReactNode;
}

const LOCAL_AGENTS: LocalAgent[] = [
  {
    capability: "claude-code",
    label: "Claude Code",
    description: "Runs through the Claude Code CLI",
    icon: <ClaudeCodeIcon size={18} />,
  },
  {
    capability: "codex",
    label: "Codex",
    description: "Runs through the Codex CLI",
    icon: <CodexIcon size={18} />,
  },
];

/**
 * Format the link's capability list for UI display. Drops
 * `decopilot-sandbox` (always present and not meaningful to the user)
 * and maps the rest to friendly labels. Returns the empty array when
 * nothing user-facing is available.
 */
export function visibleCapabilities(caps: readonly Capability[]): string[] {
  return LOCAL_AGENTS.filter((agent) => caps.includes(agent.capability)).map(
    (agent) => agent.label,
  );
}

interface ConnectDesktopDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectDesktopDialog({
  open,
  onOpenChange,
}: ConnectDesktopDialogProps) {
  const link = useCurrentLink();
  const [copied, setCopied] = useState(false);
  const desktopName = link.hostname ?? link.machineId ?? "Your desktop";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {link.online ? "Desktop connected" : "Connect your desktop"}
          </DialogTitle>
          <DialogDescription>
            {link.online
              ? `${desktopName} is online. Here's the available local agents.`
              : "Run this command in your desktop terminal. The dialog will close once your desktop is online."}
          </DialogDescription>
        </DialogHeader>

        {!link.online && (
          <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 font-mono text-sm">
            <span className="flex-1">{INSTALL_SNIPPET}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                navigator.clipboard.writeText(INSTALL_SNIPPET);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check size={14} /> : <Copy01 size={14} />}
            </Button>
          </div>
        )}

        {!link.online ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" />
            Waiting for desktop…
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Local agents
            </p>
            <div className="flex flex-col gap-2">
              {LOCAL_AGENTS.map((agent) => {
                const available = link.capabilities.includes(agent.capability);
                return (
                  <div
                    key={agent.capability}
                    className={cn(
                      "flex items-center gap-3 rounded-md border px-3 py-2",
                      available
                        ? "border-border bg-background text-foreground"
                        : "border-border/60 bg-muted/40 text-muted-foreground",
                    )}
                  >
                    <div
                      className={cn(
                        "flex size-8 items-center justify-center rounded-md border",
                        available
                          ? "border-border bg-muted text-foreground"
                          : "border-border/60 bg-background/50 text-muted-foreground",
                      )}
                    >
                      {agent.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{agent.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {available ? agent.description : "Not detected"}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        available ? "bg-success" : "bg-muted-foreground/30",
                      )}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
