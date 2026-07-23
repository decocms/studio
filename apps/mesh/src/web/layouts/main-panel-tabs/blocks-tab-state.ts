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

// Phases where the daemon is reachable AND the repo is already cloned, so the
// committed `.deco/*.gen.json` snapshot is readable even before the dev server
// is up. Blocks edits persist to the FS, so the editor stays usable throughout
// boot — mirroring Content, which renders as soon as the sandbox handle exists
// rather than waiting for the dev server to reach `running`. `crashed` (dev
// server died but daemon alive) is included for the same reason. `idle` and
// `cloning` are excluded: the daemon isn't serving the snapshot yet, so we show
// loading rather than a false "empty" from a 404 on a not-yet-cloned file.
const SNAPSHOT_READABLE_PHASES = new Set<LifecycleState["phase"]>([
  "checking-out",
  "installing",
  "starting",
  "running",
  "crashed",
]);

export function resolveBlocksTabState(
  input: BlocksTabStateInput,
): BlocksTabState {
  // Genuine setup failures stay terminal. `crashed` is recoverable (see
  // SNAPSHOT_READABLE_PHASES) — the committed snapshot is still editable, only
  // the live preview is broken until the dev server is back.
  if (
    TERMINAL_LIFECYCLE_PHASES.has(input.lifecyclePhase) &&
    input.lifecyclePhase !== "crashed"
  ) {
    return { kind: "error", source: "sandbox" };
  }
  if (!SNAPSHOT_READABLE_PHASES.has(input.lifecyclePhase)) {
    return { kind: "loading" };
  }

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
