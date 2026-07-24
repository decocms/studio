import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events";
import { SandboxStateCard } from "@/components/sandbox/preview/state-card";
import { derivePhaseProgress } from "@/components/sandbox/preview/derive-phase-progress";
import { type SandboxStartError } from "@/components/sandbox/preview/preview-state";

/**
 * Renders the SandboxStateCard variant that matches the current
 * sandbox state. Mirrors Preview's switch so Content shows the same
 * "Starting your sandbox" / "Sandbox is paused" cards. The daemon's
 * HTTP proxy serves every other "not live" case as auto-reloading
 * HTML through the iframe, so Content only needs these two overlays.
 */
export function SandboxStateRenderer({
  state,
  claimPhase,
  lifecycle,
  onStart,
  connectionsHref,
}: {
  state:
    | { kind: "starting" }
    | { kind: "suspended" }
    | { kind: "errored"; error: SandboxStartError };
  claimPhase: ReturnType<typeof useSandboxEvents>["phase"];
  lifecycle: ReturnType<typeof useSandboxEvents>["lifecycle"];
  onStart: () => void;
  connectionsHref?: string;
}) {
  switch (state.kind) {
    case "starting":
      return (
        <SandboxStateCard
          kind="starting"
          progress={derivePhaseProgress({ claimPhase, lifecycle })}
          claimPhase={claimPhase}
        />
      );
    case "suspended":
      return <SandboxStateCard kind="suspended" onResume={onStart} />;
    case "errored":
      return (
        <SandboxStateCard
          kind="errored"
          error={state.error}
          onRetry={onStart}
          connectionsHref={connectionsHref}
        />
      );
  }
}
