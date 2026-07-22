import type { LifecycleState } from "@decocms/sandbox/shared";

type QueryStatus = "pending" | "error" | "success";

export interface BlocksQueryState {
  status: QueryStatus;
  hasData: boolean;
  errorStatus?: number;
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
  // `crashed` = the dev server was running and stopped responding (paused or
  // died). The committed `.deco/*.gen.json` is still readable from the daemon,
  // so treat it like `running` here and let the data drive the state: the user
  // can still edit blocks (writes persist to the FS), only the live preview is
  // broken until the dev server is back. Genuine setup failures stay terminal.
  const devUpOrRecoverable =
    input.lifecyclePhase === "running" || input.lifecyclePhase === "crashed";

  if (
    TERMINAL_LIFECYCLE_PHASES.has(input.lifecyclePhase) &&
    input.lifecyclePhase !== "crashed"
  ) {
    return { kind: "error", source: "sandbox" };
  }
  if (!devUpOrRecoverable) return { kind: "loading" };

  const blocksFrameworkMissing = [input.decofile, input.meta].some(
    (query) =>
      query.status === "error" && !query.hasData && query.errorStatus === 404,
  );
  if (blocksFrameworkMissing) return { kind: "empty" };

  const initialDataFailed =
    (input.decofile.status === "error" && !input.decofile.hasData) ||
    (input.meta.status === "error" && !input.meta.hasData);
  if (initialDataFailed) return { kind: "error", source: "data" };

  if (!input.decofile.hasData || !input.meta.hasData) {
    return { kind: "loading" };
  }

  return input.hasEditableContent ? { kind: "content" } : { kind: "empty" };
}
