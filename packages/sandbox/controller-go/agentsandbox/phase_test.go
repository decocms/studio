package agentsandbox

import (
	"context"
	"errors"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
)

func podWith(scheduled corev1.ConditionStatus, reason string, waiting string, running, ready bool) *corev1.Pod {
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "p"}}
	if scheduled != "" {
		pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodScheduled, Status: scheduled, Reason: reason, Message: "0/3 nodes"}}
	}
	cs := corev1.ContainerStatus{Name: mainContainer, Ready: ready}
	if waiting != "" {
		cs.State.Waiting = &corev1.ContainerStateWaiting{Reason: waiting}
	}
	if running {
		cs.State.Running = &corev1.ContainerStateRunning{}
	}
	pod.Status.ContainerStatuses = []corev1.ContainerStatus{cs, {Name: "org-fs", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}}}
	return pod
}

func event(reason, msg string) corev1.Event {
	return corev1.Event{Reason: reason, Message: msg, InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: "p"}}
}

func TestDerivePhase(t *testing.T) {
	start := time.Unix(1_000, 0)
	for _, tc := range []struct {
		name   string
		pod    *corev1.Pod
		events []corev1.Event
		ready  bool
		at     time.Duration
		want   protocol.PhaseKind
		reason protocol.FailureReason
	}{
		{name: "nothing observed is claiming", want: protocol.PhaseClaiming},
		{name: "claim Ready wins over everything", ready: true, pod: podWith("", "", "ImagePullBackOff", false, false), want: protocol.PhaseReady},
		{name: "PodScheduled=False Unschedulable waits for capacity", pod: podWith(corev1.ConditionFalse, "Unschedulable", "", false, false), want: protocol.PhaseWaitingForCapacity},
		{name: "a FailedScheduling event alone waits for capacity", pod: podWith("", "", "", false, false), events: []corev1.Event{event("FailedScheduling", "0/3")}, want: protocol.PhaseWaitingForCapacity},
		{name: "Pulling without Pulled is pulling-image", pod: podWith(corev1.ConditionTrue, "", "ContainerCreating", false, false), events: []corev1.Event{event("Pulling", "")}, want: protocol.PhasePullingImage},
		{name: "ContainerCreating after Pulled starts the container", pod: podWith(corev1.ConditionTrue, "", "ContainerCreating", false, false), events: []corev1.Event{event("Pulling", ""), event("Pulled", "")}, want: protocol.PhaseStartingContainer},
		{name: "ContainerCreating with a cached image starts the container", pod: podWith(corev1.ConditionTrue, "", "ContainerCreating", false, false), want: protocol.PhaseStartingContainer},
		{name: "PodInitializing starts the container", pod: podWith(corev1.ConditionTrue, "", "PodInitializing", false, false), want: protocol.PhaseStartingContainer},
		{name: "scheduled with no status yet starts the container", pod: podWith(corev1.ConditionTrue, "", "", false, false), want: protocol.PhaseStartingContainer},
		{name: "running but not ready warms the daemon", pod: podWith(corev1.ConditionTrue, "", "", true, false), want: protocol.PhaseWarmingDaemon},
		{name: "ImagePullBackOff fails", pod: podWith(corev1.ConditionTrue, "", "ImagePullBackOff", false, false), want: protocol.PhaseFailed, reason: protocol.FailureImagePullBackoff},
		{name: "ErrImagePull fails", pod: podWith(corev1.ConditionTrue, "", "ErrImagePull", false, false), want: protocol.PhaseFailed, reason: protocol.FailureImagePullBackoff},
		{name: "CrashLoopBackOff on the sandbox container fails", pod: podWith(corev1.ConditionTrue, "", "CrashLoopBackOff", false, false), want: protocol.PhaseFailed, reason: protocol.FailureCrashLoopBackoff},
		{name: "FailedScheduling past the timeout fails", pod: podWith(corev1.ConditionFalse, "Unschedulable", "", false, false), events: []corev1.Event{event("FailedScheduling", "0/3")}, at: schedulingTimeout + time.Second, want: protocol.PhaseFailed, reason: protocol.FailureSchedulingTimeout},
		{name: "no scheduling timeout without a FailedScheduling event", pod: podWith(corev1.ConditionFalse, "Unschedulable", "", false, false), at: schedulingTimeout + time.Hour, want: protocol.PhaseWaitingForCapacity},
		{name: "another pod's events are ignored", pod: podWith(corev1.ConditionTrue, "", "ContainerCreating", false, false), events: []corev1.Event{{Reason: "Pulling", InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: "other"}}}, want: protocol.PhaseStartingContainer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := &observed{startedAt: start, claimReady: tc.ready}
			if tc.pod != nil {
				o.applyPod(tc.pod)
			}
			o.applyEvents(tc.events)
			got := derivePhase(o, start.Add(tc.at))
			if got.Kind != tc.want || got.Reason != tc.reason {
				t.Fatalf("got %+v, want %s/%s", got, tc.want, tc.reason)
			}
		})
	}
}

func TestDerivePhaseNominatedNodeClaim(t *testing.T) {
	o := &observed{startedAt: time.Unix(0, 0)}
	o.applyPod(podWith(corev1.ConditionFalse, "Unschedulable", "", false, false))
	o.applyEvents([]corev1.Event{event("Nominated", "Pod should schedule on: nodeclaim/sandbox-fr6gf")})
	if got := derivePhase(o, time.Unix(1, 0)); got.NodeClaim != "sandbox-fr6gf" {
		t.Fatalf("got %+v", got)
	}
}

func feed(phases ...protocol.Phase) <-chan protocol.Phase {
	ch := make(chan protocol.Phase, len(phases))
	for _, p := range phases {
		ch <- p
	}
	return ch
}

func TestWaitReadyOn(t *testing.T) {
	ctx := context.Background()
	t.Run("keeps waiting past the stall budget while phases arrive", func(t *testing.T) {
		ch := make(chan protocol.Phase)
		done := make(chan error, 1)
		go func() { done <- waitReadyOn(ctx, ch, 80*time.Millisecond) }()
		for _, k := range []protocol.PhaseKind{protocol.PhaseWaitingForCapacity, protocol.PhasePullingImage, protocol.PhaseStartingContainer, protocol.PhaseWarmingDaemon} {
			time.Sleep(50 * time.Millisecond)
			ch <- protocol.Phase{Kind: k}
		}
		ch <- protocol.Phase{Kind: protocol.PhaseReady}
		if err := <-done; err != nil {
			t.Fatalf("200ms of steady progress with an 80ms stall budget failed: %v", err)
		}
	})
	t.Run("fails when the phase stops moving", func(t *testing.T) {
		err := waitReadyOn(ctx, make(chan protocol.Phase), 20*time.Millisecond)
		if code, _ := runtime.CodeOf(err); code != protocol.ErrClaimStalled {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("fails right away on a terminal failure", func(t *testing.T) {
		err := waitReadyOn(ctx, feed(protocol.Phase{Kind: protocol.PhaseFailed, Message: "image pull"}), time.Hour)
		var re *runtime.Error
		if !errors.As(err, &re) || re.Code != protocol.ErrClaimFailed || re.Message != "image pull" {
			t.Fatalf("got %v", err)
		}
	})
}
