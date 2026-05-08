/**
 * Lifecycle phase types for `SandboxRunner.watchClaimLifecycle`.
 *
 * Lives at the runner package root (rather than under `agent-sandbox/`) so the
 * runner abstraction can reference these without depending on a concrete impl.
 * Pure types — no runtime imports — so type-only consumers (notably the studio
 * web bundle) can pull them in without dragging `@kubernetes/client-node`
 * through the dependency graph.
 *
 * Most phases originate from agent-sandbox's K8s watcher (image pulls, node
 * provisioning, etc.). Host/docker/freestyle yield a single `ready` phase
 * because they have no equivalent pre-Ready window worth surfacing — VM_START
 * returns once the daemon's HTTP server is up, which is fast.
 */

export type ClaimFailureReason =
  | "image-pull-backoff"
  | "crash-loop-backoff"
  | "scheduling-timeout"
  | "claim-never-created"
  | "reconciler-error"
  | "unknown";

export type ClaimPhase =
  | { kind: "claiming"; since: number }
  | {
      kind: "waiting-for-capacity";
      since: number;
      message?: string;
      /** Karpenter-emitted nodeclaim name when a node is being provisioned. */
      nodeClaim?: string;
    }
  | { kind: "pulling-image"; since: number }
  | { kind: "starting-container"; since: number }
  | { kind: "warming-daemon"; since: number }
  | { kind: "ready" }
  | { kind: "failed"; reason: ClaimFailureReason; message: string };
