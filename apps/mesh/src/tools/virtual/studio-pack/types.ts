import type { StudioContext } from "@/core/studio-context";

export type RuntimeResolveContext = {
  orgId: string;
  ctx: StudioContext;
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
  ctx: StudioContext;
};

/**
 * What happens when a home-next-action card is clicked.
 * `open-agent-thread`: create a new thread on the named agent and autosend
 *   the resolved MCP prompt named by `promptName`.
 */
export type ChecklistItemAction = {
  kind: "open-agent-thread";
  promptName: string;
};

export type StudioPackChecklistItem = {
  /** Short imperative shown in the checklist UI ("Set up your brand"). */
  label: string;
  /** Present-continuous form for in-progress UI ("Setting up your brand"). */
  activeForm: string;
  action: ChecklistItemAction;
  isCompleted: (c: ChecklistContext) => Promise<boolean>;
  /**
   * Keep offering this prompt as a chat icebreaker even after `isCompleted`.
   * For repeatable actions (e.g. creating another landing page) that aren't
   * one-time setup steps. Defaults to false (hide once complete).
   */
  alwaysSuggest?: boolean;
};

export type ResolvedChecklistItem = {
  label: string;
  activeForm: string;
  action: ChecklistItemAction;
  completed: boolean;
  alwaysSuggest?: boolean;
};

export type StudioPackConnectionKey =
  | "self"
  | "registry"
  | "community-registry";
