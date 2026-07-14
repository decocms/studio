import type { LifecycleState } from "@decocms/sandbox/shared";

type QueryStatus = "pending" | "error" | "success";

export interface BlocksQueryState {
  status: QueryStatus;
  hasData: boolean;
}

export interface BlocksTabStateInput {
  lifecyclePhase: LifecycleState["phase"];
  decofile: BlocksQueryState;
  meta: BlocksQueryState;
  hasEditableContent: boolean;
}

export type BlocksTabState =
  | { kind: "loading" }
  | { kind: "content" }
  | { kind: "empty" }
  | { kind: "error"; source: "sandbox" | "data" };

const TERMINAL_LIFECYCLE_PHASES = new Set<LifecycleState["phase"]>([
  "clone-failed",
  "install-failed",
  "start-failed",
  "crashed",
]);

export function resolveBlocksTabState(
  input: BlocksTabStateInput,
): BlocksTabState {
  if (TERMINAL_LIFECYCLE_PHASES.has(input.lifecyclePhase)) {
    return { kind: "error", source: "sandbox" };
  }
  if (input.lifecyclePhase !== "running") return { kind: "loading" };

  const initialDataFailed =
    (input.decofile.status === "error" && !input.decofile.hasData) ||
    (input.meta.status === "error" && !input.meta.hasData);
  if (initialDataFailed) return { kind: "error", source: "data" };

  if (!input.decofile.hasData || !input.meta.hasData) {
    return { kind: "loading" };
  }

  return input.hasEditableContent ? { kind: "content" } : { kind: "empty" };
}
