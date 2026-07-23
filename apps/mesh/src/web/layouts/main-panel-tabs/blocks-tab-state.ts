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

type PhaseClass =
  /** Setup failed for good — surface a sandbox error card. */
  | "terminal-error"
  /** Daemon not serving reads yet (no clone / no daemon) — show loading. */
  | "booting"
  /**
   * Daemon reachable AND repo cloned, so the committed `.deco/*.gen.json`
   * snapshot is readable — even before the dev server reaches `running`. This
   * is what lets Blocks open during boot (mirroring Content, which renders as
   * soon as the sandbox handle exists). `crashed` (dev server died, daemon
   * alive) is here too: the snapshot stays editable, only the live preview is
   * broken until the dev server is back.
   */
  | "snapshot-readable";

// Exhaustive over `LifecycleState["phase"]`: the switch has no `default`, so
// adding a phase to the union is a compile error here rather than a silent
// fall-through to the wrong state.
function classifyPhase(phase: LifecycleState["phase"]): PhaseClass {
  switch (phase) {
    case "clone-failed":
    case "install-failed":
    case "start-failed":
      return "terminal-error";
    case "idle":
    case "cloning":
      return "booting";
    case "checking-out":
    case "installing":
    case "starting":
    case "running":
    case "crashed":
      return "snapshot-readable";
  }
}

export function resolveBlocksTabState(
  input: BlocksTabStateInput,
): BlocksTabState {
  const phaseClass = classifyPhase(input.lifecyclePhase);
  if (phaseClass === "terminal-error")
    return { kind: "error", source: "sandbox" };
  if (phaseClass === "booting") return { kind: "loading" };

  const blocksFrameworkMissing = [input.decofile, input.meta].some(
    (query) =>
      query.status === "error" && !query.hasData && query.errorStatus === 404,
  );
  if (blocksFrameworkMissing) return { kind: "empty" };

  const initialDataFailed =
    (input.decofile.status === "error" && !input.decofile.hasData) ||
    (input.meta.status === "error" && !input.meta.hasData);
  if (initialDataFailed) {
    // While booting, the committed snapshot may not be written yet, and an
    // absent file surfaces as a synthetic 502 from the read fallback (see
    // `use-decofile`), NOT a 404 — so it can't be classified as "framework
    // missing" above. Treat it as loading instead of a hard data error: the
    // `→running` lifecycle transition re-invalidates both queries and resolves
    // content/empty authoritatively. Only surface the error once the dev
    // server has settled (running/crashed), where the failure is real.
    const devSettled =
      input.lifecyclePhase === "running" || input.lifecyclePhase === "crashed";
    return devSettled ? { kind: "error", source: "data" } : { kind: "loading" };
  }

  if (!input.decofile.hasData || !input.meta.hasData) {
    return { kind: "loading" };
  }

  return input.hasEditableContent ? { kind: "content" } : { kind: "empty" };
}
