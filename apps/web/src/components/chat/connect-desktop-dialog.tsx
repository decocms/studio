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
import type { Capability } from "@decocms/sandbox/dispatch";
import { useCurrentLink } from "@/hooks/use-current-link";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";
import { ClaudeCodeIcon, CodexIcon } from "./agent-icons";

const INSTALL_SNIPPET = "bunx decocms@latest link";

interface LocalAgent {
  capability: Capability;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: ReactNode;
}

const LOCAL_AGENTS: LocalAgent[] = [
  {
    capability: "claude-code",
    labelKey: "chat.connectDesktopDialog.agentClaudeCodeLabel",
    descriptionKey: "chat.connectDesktopDialog.agentClaudeCodeDescription",
    icon: <ClaudeCodeIcon size={18} />,
  },
  {
    capability: "codex",
    labelKey: "chat.connectDesktopDialog.agentCodexLabel",
    descriptionKey: "chat.connectDesktopDialog.agentCodexDescription",
    icon: <CodexIcon size={18} />,
  },
] as const;
interface ConnectDesktopDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectDesktopDialog({
  open,
  onOpenChange,
}: ConnectDesktopDialogProps) {
  const t = useT();
  const link = useCurrentLink({ fast: open });
  const [copied, setCopied] = useState(false);
  const desktopName =
    link.hostname ??
    link.machineId ??
    t("chat.connectDesktopDialog.yourDesktop");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {link.online
              ? t("chat.connectDesktopDialog.connectedTo", { desktopName })
              : t("chat.connectDesktopDialog.connectYourDesktop")}
          </DialogTitle>
          <DialogDescription>
            {link.online
              ? t("chat.connectDesktopDialog.machineAgentsDescription")
              : t("chat.connectDesktopDialog.runCommandDescription")}
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
                navigator.clipboard.writeText(INSTALL_SNIPPET).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check size={14} /> : <Copy01 size={14} />}
            </Button>
          </div>
        )}

        {!link.online ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" />
            {t("chat.connectDesktopDialog.waitingForDesktop")}
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
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
                        "flex size-6 items-center justify-center",
                        available ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {agent.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{t(agent.labelKey)}</p>
                      <p className="text-xs text-muted-foreground">
                        {available
                          ? t(agent.descriptionKey)
                          : t("chat.connectDesktopDialog.notDetected")}
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
