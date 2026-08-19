import type { LifecycleState } from "@decocms/sandbox/shared";
import type { PreviewState } from "@/components/sandbox/preview/preview-state";

/** A preview state the sandbox card owns — everything but a live iframe. */
export type SandboxCardState = Exclude<PreviewState, { kind: "iframe" }>;

/** What owns the Content tab's canvas before its data is considered. */
export type ContentSandboxGate =
  /** Hand the canvas to the sandbox card (booting / suspended / errored). */
  | { kind: "sandbox-card"; state: SandboxCardState }
  /**
   * Render the browser. `devServerReady` says the live `/.decofile` and
   * `/live/_meta` routes are worth hitting; `sandboxWarming` says a missing
   * read is still expected to arrive, so the browser spins instead of erroring.
   */
  | { kind: "ready"; devServerReady: boolean; sandboxWarming: boolean };

/** Phases after which no further boot progress is coming. */
const TERMINAL_PHASES: ReadonlySet<LifecycleState["phase"]> = new Set([
  "clone-failed",
  "install-failed",
  "start-failed",
  "crashed",
]);

/**
 * Which surface the Content tab shows, given the session's runtime.
 *
 * Sandbox-less Fast Preview is the whole reason this is a function: content
 * comes from the decofile API over GitHub, so there is no pod to wait for. The
 * lifecycle sits at `idle` forever and `previewState` at `starting` forever —
 * gating on either painted the "Cloning your repo" boot card over a tab that
 * had nothing to boot, and left `sandboxWarming` stuck true so a failed read
 * spun rather than surfacing. Fast Preview therefore ignores both inputs: data
 * readiness alone decides, exactly as it does for the Blocks panel
 * (`resolveBlocksTabState`).
 */
export function resolveContentSandboxGate(input: {
  fastPreviewActive: boolean;
  previewState: PreviewState;
  lifecyclePhase: LifecycleState["phase"];
}): ContentSandboxGate {
  if (input.fastPreviewActive) {
    return { kind: "ready", devServerReady: false, sandboxWarming: false };
  }
  if (input.previewState.kind !== "iframe") {
    return { kind: "sandbox-card", state: input.previewState };
  }

  const devServerReady = input.lifecyclePhase === "running";
  const sandboxWarming =
    !devServerReady && !TERMINAL_PHASES.has(input.lifecyclePhase);
  return { kind: "ready", devServerReady, sandboxWarming };
}
