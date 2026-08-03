import type { ReactNode } from "react";
import { Monitor01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { useAgentCapabilities } from "@/desktop/agent-terminal/use-agent-capabilities";
import { useT } from "@/i18n/use-t.ts";
import { ClaudeCodeIcon, CodexIcon } from "./agent-icons";
import { useChatPrefs } from "./context";
import type { LocalAgentOption } from "./pills/agent-options";

/**
 * Native counterpart of `NoAiProviderEmptyState`. The desktop app has no
 * cloud runtime, so there is no provider grid to offer — the only way to run
 * a chat is a local coding agent. Shown by the chat side panel while the
 * native agent resolver has no option yet (CLI detection cold, or neither
 * CLI detected).
 *
 * Both options are always offered: availability is advisory in this codebase
 * and must not prevent selection. Picking one persists the pending agent
 * option, which resolves the gate and launches the terminal — the escape
 * hatch out of a stuck detection state.
 */
export function NativeAgentEmptyState({
  onSelect,
}: {
  onSelect?: (option: LocalAgentOption) => void;
}) {
  const t = useT();
  const availability = useAgentCapabilities();
  const { setPendingAgentOption } = useChatPrefs();

  const options: Array<{
    option: LocalAgentOption;
    label: string;
    icon: ReactNode;
    detected: boolean;
  }> = [
    {
      option: "claude-code-desktop",
      label: "Claude Code",
      icon: <ClaudeCodeIcon size={16} />,
      detected: availability.capabilities.includes("claude-code"),
    },
    {
      option: "codex-desktop",
      label: "Codex",
      icon: <CodexIcon size={16} />,
      detected: availability.capabilities.includes("codex"),
    },
  ];

  const anyDetected = options.some((o) => o.detected);
  const subtitle = !availability.ready
    ? t("chat.nativeAgentEmptyState.subtitleDetecting")
    : anyDetected
      ? t("chat.nativeAgentEmptyState.subtitlePick")
      : t("chat.nativeAgentEmptyState.subtitleNoneDetected");

  return (
    <div className="flex flex-col items-center gap-8 w-full max-w-3xl px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex items-center justify-center size-14 rounded-2xl bg-muted border border-border">
          <span className="relative inline-flex items-center justify-center">
            <Monitor01 size={24} className="text-muted-foreground" />
            {anyDetected && (
              <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-success ring-2 ring-background animate-pulse" />
            )}
          </span>
        </div>
        <div className="space-y-2">
          <p className="text-xl font-semibold text-foreground tracking-tight">
            {t("chat.nativeAgentEmptyState.heading")}
          </p>
          <p className="text-sm text-muted-foreground max-w-md">{subtitle}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {options.map((o) => (
          <Button
            key={o.option}
            variant={o.detected ? "default" : "outline"}
            className="gap-2"
            title={
              availability.ready && !o.detected
                ? t("chat.nativeAgentEmptyState.notDetected", {
                    label: o.label,
                  })
                : undefined
            }
            onClick={() => {
              setPendingAgentOption(o.option);
              onSelect?.(o.option);
            }}
          >
            {o.icon}
            {t("chat.noAiProviderEmptyState.useLabel", { label: o.label })}
          </Button>
        ))}
      </div>
    </div>
  );
}
