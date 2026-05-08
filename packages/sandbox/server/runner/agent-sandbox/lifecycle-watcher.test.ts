/**
 * Reducer tests for the claim lifecycle watcher.
 *
 * The watch transports (kubeFetch + ndjson) are exercised end-to-end by the
 * existing client.test.ts and by integration runs against a real cluster.
 * What's worth unit-testing here is the pure phase reducer — it's the part
 * that encodes the contract between observed K8s state and what the user
 * sees, and it's the part most likely to grow new branches as we learn more
 * failure modes.
 */

import { describe, expect, it } from "bun:test";
import { derivePhase } from "./lifecycle-watcher";
import type { ClaimPhase } from "./lifecycle-types";

type State = Parameters<typeof derivePhase>[0];

const T0 = 1_000_000;
const fixedNow =
  (t = T0) =>
  () =>
    t;

function baseState(): State {
  return {
    pod: {},
    sandbox: {},
    events: { hasPulling: false, hasPulled: false },
    startedAt: T0,
  };
}

const TIMEOUT_MS = 5 * 60 * 1000;

describe("derivePhase", () => {
  it("defaults to claiming when nothing is observed", () => {
    const phase = derivePhase(baseState(), TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("claiming");
  });

  it("ready trumps everything when Sandbox.Ready=True", () => {
    const state = baseState();
    state.sandbox.ready = true;
    // Stuff conflicting signals in to make sure they're ignored.
    state.pod.containerWaitingReason = "ImagePullBackOff";
    state.events.lastFailedSchedulingAt = T0;
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("ready");
  });

  it("waits for capacity when PodScheduled=False", () => {
    const state = baseState();
    state.pod.scheduled = false;
    state.pod.scheduledFalseReason = "Unschedulable";
    state.pod.scheduledFalseMessage = "0/15 nodes are available";
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("waiting-for-capacity");
    if (phase.kind === "waiting-for-capacity") {
      expect(phase.message).toBe("0/15 nodes are available");
    }
  });

  it("waits for capacity when only a FailedScheduling event has been seen", () => {
    const state = baseState();
    state.events.lastFailedSchedulingAt = T0;
    state.events.failedSchedulingMessage = "Insufficient memory";
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("waiting-for-capacity");
    if (phase.kind === "waiting-for-capacity") {
      expect(phase.message).toBe("Insufficient memory");
    }
  });

  it("surfaces karpenter nodeClaim hint inside waiting-for-capacity", () => {
    const state = baseState();
    state.pod.scheduledFalseReason = "Unschedulable";
    state.events.nominatedNodeClaim = "sandbox-fr6gf";
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("waiting-for-capacity");
    if (phase.kind === "waiting-for-capacity") {
      expect(phase.nodeClaim).toBe("sandbox-fr6gf");
    }
  });

  it("emits pulling-image when Pulling has been observed but not Pulled", () => {
    const state = baseState();
    state.pod.scheduled = true;
    state.events.hasPulling = true;
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("pulling-image");
  });

  it("emits starting-container when ContainerCreating + Pulled", () => {
    const state = baseState();
    state.pod.scheduled = true;
    state.pod.containerWaitingReason = "ContainerCreating";
    state.events.hasPulling = true;
    state.events.hasPulled = true;
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("starting-container");
  });

  it("emits starting-container on ContainerCreating even without a Pulled event (cached image)", () => {
    // Real karpenter case: image is already on the node so kubelet skips
    // straight from ContainerCreating to running, and the `Pulled` event
    // either lags the container-status update or arrives as "image already
    // present on machine" without a prior `Pulling`. Either way the user
    // wants to see `starting-container`, not stay pinned at the prior phase.
    const state = baseState();
    state.pod.scheduled = true;
    state.pod.containerWaitingReason = "ContainerCreating";
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("starting-container");
  });

  it("emits starting-container on PodInitializing", () => {
    const state = baseState();
    state.pod.scheduled = true;
    state.pod.containerWaitingReason = "PodInitializing";
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("starting-container");
  });

  it("emits starting-container after schedule even before kubelet reports a containerStatus", () => {
    // Brief window between PodScheduled=True and the first containerStatus
    // tick. Without this branch we'd fall through to `claiming` and the
    // generator's monotonic floor would pin us at the prior
    // `waiting-for-capacity` for the entire ContainerCreating window.
    const state = baseState();
    state.pod.scheduled = true;
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("starting-container");
  });

  it("emits warming-daemon when container is running but not yet ready", () => {
    const state = baseState();
    state.pod.scheduled = true;
    state.pod.containerRunning = true;
    state.pod.containerReady = false;
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("warming-daemon");
  });

  it("ignores warming-daemon when container is also ready (sandbox-ready takes over via separate signal)", () => {
    // The Sandbox CR's Ready=True is the canonical readiness; container.ready
    // alone (without sandbox.ready) shouldn't be treated as terminal because
    // there's still ~the Service patch + HTTPRoute mint window before the
    // operator flips Ready=True. Keep emitting warming-daemon until
    // sandbox.ready arrives.
    const state = baseState();
    state.pod.scheduled = true;
    state.pod.containerRunning = true;
    state.pod.containerReady = true;
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    // containerReady=true means the reducer falls through warming-daemon
    // (running && !ready is false) — it doesn't auto-terminate. The next
    // best signal is the events/scheduling state. With a scheduled pod and
    // no waiting reason, that resolves to claiming (no other signals set).
    expect(phase.kind).toBe("claiming");
  });

  it("fails on ImagePullBackOff", () => {
    const state = baseState();
    state.pod.containerWaitingReason = "ImagePullBackOff";
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("failed");
    if (phase.kind === "failed") {
      expect(phase.reason).toBe("image-pull-backoff");
    }
  });

  it("fails on ErrImagePull", () => {
    const state = baseState();
    state.pod.containerWaitingReason = "ErrImagePull";
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("failed");
    if (phase.kind === "failed") {
      expect(phase.reason).toBe("image-pull-backoff");
    }
  });

  it("fails on CrashLoopBackOff", () => {
    const state = baseState();
    state.pod.containerWaitingReason = "CrashLoopBackOff";
    const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
    expect(phase.kind).toBe("failed");
    if (phase.kind === "failed") {
      expect(phase.reason).toBe("crash-loop-backoff");
    }
  });

  it("fails on scheduling-timeout only after FailedScheduling AND elapsed > timeout", () => {
    const state = baseState();
    state.events.lastFailedSchedulingAt = T0;
    state.events.failedSchedulingMessage = "0/15 nodes are available";
    // Just below the timeout — still waiting-for-capacity.
    const stillWaiting = derivePhase(
      state,
      TIMEOUT_MS,
      fixedNow(T0 + TIMEOUT_MS - 1),
    );
    expect(stillWaiting.kind).toBe("waiting-for-capacity");
    // Just above — flips to failed.
    const failed = derivePhase(
      state,
      TIMEOUT_MS,
      fixedNow(T0 + TIMEOUT_MS + 1),
    );
    expect(failed.kind).toBe("failed");
    if (failed.kind === "failed") {
      expect(failed.reason).toBe("scheduling-timeout");
      expect(failed.message).toContain("0/15 nodes are available");
    }
  });

  it("does NOT scheduling-timeout without a FailedScheduling event", () => {
    // Slow PodScheduled=True transition shouldn't be misread as a timeout.
    const state = baseState();
    const phase = derivePhase(
      state,
      TIMEOUT_MS,
      fixedNow(T0 + TIMEOUT_MS * 10),
    );
    expect(phase.kind).toBe("claiming");
  });
});

describe("watchClaimLifecycle progression (sequenced by reducer)", () => {
  // End-to-end progression covering the realistic happy path observed on
  // staging:
  //   claim posted → unschedulable → karpenter nominates → pulling →
  //   pulled+creating → running-not-ready → ready
  it("walks the happy karpenter path", () => {
    const state = baseState();
    const seen: ClaimPhase["kind"][] = [];
    const observe = () => {
      const phase = derivePhase(state, TIMEOUT_MS, fixedNow());
      const last = seen[seen.length - 1];
      if (last !== phase.kind) seen.push(phase.kind);
    };

    observe(); // claiming
    state.pod.scheduledFalseReason = "Unschedulable";
    state.events.lastFailedSchedulingAt = T0;
    state.events.failedSchedulingMessage = "0/15 nodes are available";
    observe(); // waiting-for-capacity
    state.events.nominatedNodeClaim = "sandbox-fr6gf";
    observe(); // still waiting-for-capacity (nodeClaim doesn't change phase kind)
    state.pod.scheduled = true;
    state.pod.scheduledFalseReason = undefined;
    state.events.hasPulling = true;
    observe(); // pulling-image
    state.pod.containerWaitingReason = "ContainerCreating";
    state.events.hasPulled = true;
    observe(); // starting-container
    state.pod.containerWaitingReason = undefined;
    state.pod.containerRunning = true;
    state.pod.containerReady = false;
    observe(); // warming-daemon
    state.sandbox.ready = true;
    observe(); // ready

    expect(seen).toEqual([
      "claiming",
      "waiting-for-capacity",
      "pulling-image",
      "starting-container",
      "warming-daemon",
      "ready",
    ]);
  });
});
