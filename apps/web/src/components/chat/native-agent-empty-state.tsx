import { useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { useAgentCapabilities } from "@/desktop/agent-terminal/use-agent-capabilities";
import { useT } from "@/i18n/use-t.ts";
import { ClaudeCodeIcon, CodexIcon, OpenCodeIcon } from "./agent-icons";
import { useChatPrefs } from "./context";
import type { LocalAgentOption } from "./pills/agent-options";

export interface NativeAgentTerminalPromptOption {
  option: LocalAgentOption;
  label: string;
  icon: ReactNode;
  availability: "detecting" | "detected" | "try-anyway";
}

function movePickerFocus(
  event: KeyboardEvent<HTMLDivElement>,
  direction: -1 | 1,
): number | null {
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "[data-native-agent-option]",
    ),
  );
  if (buttons.length === 0) return null;

  const currentIndex = buttons.findIndex(
    (button) => button === document.activeElement,
  );
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : buttons.length - 1
      : (currentIndex + direction + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
  return nextIndex;
}

/**
 * Terminal-native presentation kept separate from detection/preferences so
 * its keyboard behavior can be exercised without replacing app services.
 */
export function NativeAgentTerminalPrompt({
  options,
  onSelect,
}: {
  options: NativeAgentTerminalPromptOption[];
  onSelect: (option: LocalAgentOption) => void;
}) {
  const t = useT();
  const [selectedOptionPreference, setSelectedOption] =
    useState<LocalAgentOption | null>(null);
  const selectedOption =
    options.find((item) => item.option === selectedOptionPreference)?.option ??
    options[0]?.option ??
    null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = movePickerFocus(
        event,
        event.key === "ArrowDown" ? 1 : -1,
      );
      const nextOption = nextIndex === null ? undefined : options[nextIndex];
      if (nextOption) setSelectedOption(nextOption.option);
      return;
    }

    if (event.key !== "Enter") return;
    const button =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLButtonElement>("[data-native-agent-option]")
        : null;
    if (!button || !event.currentTarget.contains(button)) return;
    event.preventDefault();
    button.click();
  };

  return (
    <section
      className="flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-sidebar shadow-sm"
      aria-labelledby="native-agent-prompt-title"
    >
      <div className="border-b border-border px-6 py-5">
        <h2
          id="native-agent-prompt-title"
          className="flex items-center gap-2 font-mono text-base font-semibold text-foreground"
        >
          <span aria-hidden="true" className="text-success">
            ›
          </span>
          {t("chat.nativeAgentEmptyState.heading")}
          <span
            aria-hidden="true"
            className="inline-block h-4 w-1.5 animate-pulse bg-foreground motion-reduce:animate-none"
          />
        </h2>
      </div>

      <div
        className="grid gap-1.5 p-3"
        role="group"
        aria-label={t("chat.nativeAgentEmptyState.agentListLabel")}
        onKeyDown={handleKeyDown}
      >
        {options.map((item) => {
          const availabilityLabel = t(
            item.availability === "detecting"
              ? "chat.nativeAgentEmptyState.detecting"
              : item.availability === "detected"
                ? "chat.nativeAgentEmptyState.detected"
                : "chat.nativeAgentEmptyState.tryAnyway",
          );

          return (
            <button
              key={item.option}
              type="button"
              autoFocus={item.option === selectedOption}
              data-native-agent-option={item.option}
              data-selected={item.option === selectedOption}
              className="group grid min-h-16 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-transparent px-3 text-left transition-colors hover:border-border hover:bg-accent focus-visible:outline-none data-[selected=true]:border-ring data-[selected=true]:bg-accent data-[selected=true]:ring-2 data-[selected=true]:ring-ring/30"
              title={
                item.availability === "try-anyway"
                  ? t("chat.nativeAgentEmptyState.notDetected", {
                      label: item.label,
                    })
                  : undefined
              }
              onFocus={() => setSelectedOption(item.option)}
              onClick={() => {
                setSelectedOption(item.option);
                onSelect(item.option);
              }}
            >
              <span
                aria-hidden="true"
                className="flex size-8 items-center justify-center text-foreground"
              >
                {item.icon}
              </span>
              <strong className="min-w-0 truncate text-sm font-semibold text-foreground">
                {item.label}
              </strong>
              <span className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    item.availability === "detecting"
                      ? "animate-pulse bg-muted-foreground motion-reduce:animate-none"
                      : item.availability === "detected"
                        ? "bg-success"
                        : "bg-warning",
                  )}
                />
                {availabilityLabel}
              </span>
            </button>
          );
        })}
      </div>

      <footer className="mt-auto flex justify-end border-t border-border px-6 py-4 text-muted-foreground">
        <span className="font-mono text-[10px]">
          {t("chat.nativeAgentEmptyState.keyboardHint")}
        </span>
      </footer>
    </section>
  );
}

/**
 * Native counterpart of `NoAiProviderEmptyState`. The desktop app has no
 * cloud runtime, so there is no provider grid to offer — the only way to run
 * a chat is a local coding agent. Shown by the chat side panel while the
 * native agent resolver has no option yet.
 *
 * All options are always offered: availability is advisory in this codebase
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
      label: t("chat.agentIcons.claudeCode"),
      icon: <ClaudeCodeIcon size={16} />,
      detected: availability.capabilities.includes("claude-code"),
    },
    {
      option: "codex-desktop",
      label: t("chat.agentIcons.codex"),
      icon: <CodexIcon size={16} />,
      detected: availability.capabilities.includes("codex"),
    },
    {
      option: "opencode-desktop",
      label: t("chat.agentIcons.opencode"),
      icon: <OpenCodeIcon size={16} />,
      detected: availability.capabilities.includes("opencode"),
    },
  ];

  return (
    <NativeAgentTerminalPrompt
      options={options.map((option) => ({
        ...option,
        availability: !availability.ready
          ? "detecting"
          : option.detected
            ? "detected"
            : "try-anyway",
      }))}
      onSelect={(option) => {
        setPendingAgentOption(option);
        onSelect?.(option);
      }}
    />
  );
}
