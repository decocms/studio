import type { MeshContext } from "@/core/mesh-context";
import type { ThreadMessage } from "@/storage/types";

export type WelcomeContext = {
  orgId: string;
  createdBy: string;
  hasBrandContext: boolean;
  hasCustomAgents: boolean;
};

export type BuildWelcomeMessage = (
  ctx: WelcomeContext,
) => Promise<ThreadMessage["parts"]>;

export type RuntimeResolveContext = {
  orgId: string;
  ctx: MeshContext;
};

export type ResolvedRuntime = {
  instructions: string;
  selectedTools: readonly string[] | null;
};

export type ResolveRuntime = (
  rt: RuntimeResolveContext,
) => Promise<ResolvedRuntime>;

export type ChecklistContext = {
  orgId: string;
  ctx: MeshContext;
};

/**
 * What happens when the user clicks a checklist item in the Tasks panel.
 * `open-agent-thread` is the default — navigate to the agent's pre-seeded
 * welcome thread (`thrd_welcome_<agentId>`). If `prompt` is set, it is
 * queued for autosend on mount; otherwise the agent's state-aware welcome
 * (rendered live from `welcomeMessage`) drives the conversation.
 * Other kinds trigger UI-side flows that don't require a thread:
 * `github-import` opens the existing GitHubRepoPicker;
 * `install-github-mcp` installs the GitHub MCP without picking a repo;
 * `add-storefront` opens the repo selector + virtual-MCP creation modal;
 * `configure-github-automations` reopens the picker so the user can wire
 * triggers onto a storefront (today reuses the add-storefront modal; a
 * future flow can scope to existing storefronts);
 * `setup-site-monitoring` opens the site-URL prompt + Site Diagnostics
 * recruit flow.
 */
export type ChecklistItemAction =
  | { kind: "open-agent-thread"; promptName: string; prompt?: string }
  | { kind: "github-import" }
  | { kind: "install-github-mcp" }
  | { kind: "add-storefront" }
  | { kind: "configure-github-automations" }
  | { kind: "setup-site-monitoring" };

export type StudioPackChecklistItem = {
  /** Short imperative shown in the checklist UI ("Set up your brand"). */
  label: string;
  /** Present-continuous form for in-progress UI ("Setting up your brand"). */
  activeForm: string;
  action: ChecklistItemAction;
  isCompleted: (c: ChecklistContext) => Promise<boolean>;
};

export type ResolvedChecklistItem = {
  label: string;
  activeForm: string;
  action: ChecklistItemAction;
  completed: boolean;
};

export type StudioPackConnectionKey =
  | "self"
  | "registry"
  | "community-registry";
