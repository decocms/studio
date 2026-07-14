/**
 * PreviewRuntimeSwitcher — where the preview (and the agent that drives it)
 * runs: deco's Cloud sandbox, or **This device** via `decocms link`.
 *
 * The agent and its preview share ONE sandbox (the agent edits files, the dev
 * server serves them), so this is the same underlying choice the chat's model
 * selector exposes as "Cloud / This device" — surfaced here because the preview
 * is where you actually care about it. It writes through the same
 * `pendingAgentOption`, so the two controls never disagree.
 *
 * The runtime locks to a thread on its first message. On a locked thread this
 * is read-only and warns that a new chat is required — it never silently
 * re-spawns one.
 */
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Cloud01,
  Lock01,
  Monitor01,
} from "@untitledui/icons";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import type { SandboxProviderKind } from "@decocms/mesh-sdk";
import { useChatPrefs, useChatTask } from "@/web/components/chat/context";
import { useAgentOptionAvailability } from "@/web/components/chat/use-agent-availability";
import type { AgentOption } from "@/web/components/chat/pills/agent-options";
import { useSandboxLifecycle } from "@/web/components/sandbox/hooks/sandbox-lifecycle-context";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

function runtimeMeta(sandbox: SandboxProviderKind | null): {
  key: "cloud" | "local";
  label: string;
  Icon: Icon;
} {
  if (sandbox === "user-desktop") {
    return { key: "local", label: "This device", Icon: Monitor01 };
  }
  return { key: "cloud", label: "Cloud sandbox", Icon: Cloud01 };
}

function RuntimeItem({
  icon,
  label,
  description,
  active,
  available,
  disabledHint,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  active: boolean;
  available: boolean;
  disabledHint: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!available}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        available
          ? "cursor-pointer hover:bg-accent"
          : "cursor-not-allowed opacity-50",
      )}
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          {label}
          {active && <Check size={13} className="text-muted-foreground" />}
        </span>
        <span className="block text-xs text-muted-foreground">
          {available ? description : disabledHint}
        </span>
      </span>
    </button>
  );
}

export function PreviewRuntimeSwitcher() {
  const { pendingSandboxProviderKind, setPendingAgentOption } = useChatPrefs();
  const { isThreadLocked, lockedSandbox, createTask } = useChatTask();
  const { vmEntry } = useSandboxLifecycle();
  const availability = useAgentOptionAvailability();

  // Prefer the sandbox that's actually running; fall back to the locked/pending
  // choice before the VM entry resolves so the label never flashes wrong.
  const currentSandbox =
    (vmEntry?.sandboxProviderKind as SandboxProviderKind | null | undefined) ??
    (isThreadLocked ? lockedSandbox : pendingSandboxProviderKind);
  const current = runtimeMeta(currentSandbox);
  const CurrentIcon = current.Icon;

  // "This device" only exists via a local CLI harness (there's no cloud-brain-
  // on-desktop option), so it's gated on a linked desktop with Claude Code or
  // Codex. Default to whichever CLI is present.
  const localOption: AgentOption | null = availability.claudeCode
    ? "claude-code-desktop"
    : availability.codex
      ? "codex-desktop"
      : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 text-[13px] font-medium"
        >
          <CurrentIcon size={14} />
          <span>{current.label}</span>
          {isThreadLocked ? (
            <Lock01 size={12} className="text-muted-foreground" />
          ) : (
            <ChevronDown
              size={12}
              className="text-muted-foreground opacity-70"
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-1">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Run preview on
        </DropdownMenuLabel>
        {isThreadLocked ? (
          <div className="flex flex-col gap-2 px-2 py-1.5">
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                This chat is locked to {current.label.toLowerCase()}. Start a
                new chat to run the preview somewhere else.
              </span>
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => createTask()}
            >
              New chat
            </Button>
          </div>
        ) : (
          <>
            <RuntimeItem
              icon={<Cloud01 size={14} />}
              label="Cloud sandbox"
              description="Runs in deco's cloud"
              active={current.key === "cloud"}
              available={availability.agentSandbox}
              disabledHint="Not available on this deployment"
              onSelect={() => setPendingAgentOption("decopilot")}
            />
            <RuntimeItem
              icon={<Monitor01 size={14} />}
              label="This device"
              description="Runs on your machine via deco link"
              active={current.key === "local"}
              available={localOption !== null}
              disabledHint="Run `decocms link` on your desktop"
              onSelect={() => localOption && setPendingAgentOption(localOption)}
            />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
