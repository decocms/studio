/**
 * RuntimeSwitcher — where the agent (and the preview it drives) runs: deco's
 * Cloud sandbox, or **This device** via `decocms link`.
 *
 * Lives in the chat's branch-pill row, NOT the preview toolbar: the preview
 * toolbar only exists once the sandbox is up, so if a sandbox can't start you'd
 * be locked out of the one control that could unstick you. Here it's always
 * reachable — you can pick the runtime before (or while) the sandbox starts.
 *
 * The agent and its preview share ONE sandbox (the agent edits files, the dev
 * server serves them), so this is the same underlying choice the chat model
 * selector exposes as "Cloud / This device" — it writes through the same
 * `pendingAgentOption`, so the two never disagree.
 *
 * The runtime locks to a thread on its first message, at which point this
 * control disappears instead of occupying space with a disabled indicator.
 */
import { Check, ChevronDown, Cloud01, Monitor01 } from "@untitledui/icons";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import type { SandboxProviderKind } from "@decocms/mesh-sdk";
import { useT } from "@/web/i18n/use-t.ts";
import { useChatPrefs, useChatTask } from "../context";
import { useAgentOptionAvailability } from "../use-agent-availability";
import { preferredLocalAgentOption } from "./agent-options";
import { useSandboxLifecycle } from "@/web/components/sandbox/hooks/sandbox-lifecycle-context";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

function runtimeMeta(
  sandbox: SandboxProviderKind | null,
  t: ReturnType<typeof useT>,
): {
  key: "cloud" | "local";
  label: string;
  Icon: Icon;
} {
  if (sandbox === "user-desktop") {
    return {
      key: "local",
      label: t("chat.runtimeSwitcher.thisDevice"),
      Icon: Monitor01,
    };
  }
  return {
    key: "cloud",
    label: t("chat.runtimeSwitcher.cloudSandbox"),
    Icon: Cloud01,
  };
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

function getRuntimeLabel(label: string): string {
  return label.toLowerCase();
}

export function RuntimeSwitcher({
  showLabel = false,
}: {
  /** Show the runtime name beside the icon. On: the spacious empty-chat
   *  landing. Off (default): the dense in-conversation composer row. */
  showLabel?: boolean;
} = {}) {
  const t = useT();
  const { pendingSandboxProviderKind, setPendingAgentOption } = useChatPrefs();
  const { isThreadLocked } = useChatTask();
  const { vmEntry } = useSandboxLifecycle();
  const availability = useAgentOptionAvailability();

  // The persisted thread state remains the source of truth after the first
  // message, so there is no useful action or status for this control to show.
  if (isThreadLocked) return null;

  // "This device" only exists via a local CLI harness (there's no cloud-brain-
  // on-desktop option), so it's gated on a linked desktop with Claude Code or
  // Codex.
  const localOption = preferredLocalAgentOption(availability);

  // Prefer the sandbox that's actually running, then the locked/pending choice.
  // When still unresolved, show the runtime that will actually be used: cloud
  // when it's available, otherwise "This device". Without this the label reads
  // "Cloud sandbox" (the null default) even where cloud can't run.
  const currentSandbox: SandboxProviderKind | null =
    (vmEntry?.sandboxProviderKind as SandboxProviderKind | null | undefined) ??
    pendingSandboxProviderKind ??
    (availability.agentSandbox
      ? "agent-sandbox"
      : localOption
        ? "user-desktop"
        : null);

  const current = runtimeMeta(currentSandbox, t);
  const CurrentIcon = current.Icon;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size={showLabel ? "sm" : "icon"}
              aria-label={t("chat.runtimeSwitcher.runtime", {
                label: current.label,
              })}
              className={cn(
                "text-muted-foreground hover:text-foreground",
                showLabel ? "h-9 gap-1.5 px-2 text-xs font-medium" : "size-9",
              )}
            >
              <CurrentIcon size={16} />
              {showLabel && (
                <>
                  <span className="truncate">{current.label}</span>
                  <ChevronDown size={12} className="shrink-0 opacity-70" />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("chat.runtimeSwitcher.runningOn", {
            label: getRuntimeLabel(current.label),
          })}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-64 p-1">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("chat.runtimeSwitcher.runOn")}
        </DropdownMenuLabel>
        <RuntimeItem
          icon={<Cloud01 size={14} />}
          label={t("chat.runtimeSwitcher.cloudSandbox")}
          description={t("chat.runtimeSwitcher.runsInDecosCloud")}
          active={current.key === "cloud"}
          available={availability.agentSandbox}
          disabledHint={t("chat.runtimeSwitcher.notAvailableOnThisDeployment")}
          onSelect={() => setPendingAgentOption("decopilot")}
        />
        <RuntimeItem
          icon={<Monitor01 size={14} />}
          label={t("chat.runtimeSwitcher.thisDevice")}
          description={t("chat.runtimeSwitcher.runsOnYourMachineViaDecoLink")}
          active={current.key === "local"}
          available={localOption !== null}
          disabledHint={t("chat.runtimeSwitcher.runDecocmsLinkOnYourDesktop")}
          onSelect={() => localOption && setPendingAgentOption(localOption)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
