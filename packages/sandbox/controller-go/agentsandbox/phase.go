package agentsandbox

import (
	"context"
	"fmt"
	"regexp"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/decocms/studio/packages/sandbox/controller-go/daemonclient"
	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
)

const (
	// schedulingTimeout fails a claim that has seen FailedScheduling and still
	// has no node this long after the watch started. On a karpenter cluster
	// this rarely trips; on fixed capacity it names the problem.
	schedulingTimeout = 5 * time.Minute
	// stallTimeout bounds the ready wait on progress, not elapsed time: a cold
	// start onto a new node that then pulls a multi-GB image keeps advancing,
	// and cutting it off only restarts it elsewhere.
	stallTimeout = 10 * time.Minute
)

// observed is what the watch has seen of one claim. Fields persist across
// polls the way the in-process watcher's state did across events.
type observed struct {
	startedAt time.Time

	claimReady bool

	podName               string
	scheduled             bool
	scheduledFalseReason  string
	scheduledFalseMessage string
	containerWaiting      string
	containerRunning      bool
	containerReady        bool

	hasPulling             bool
	hasPulled              bool
	failedSchedulingSeen   bool
	failedSchedulingReason string
	nominatedNodeClaim     string
}

func (o *observed) applyPod(pod *corev1.Pod) {
	o.podName = pod.Name
	for _, c := range pod.Status.Conditions {
		if c.Type != corev1.PodScheduled {
			continue
		}
		switch c.Status {
		case corev1.ConditionTrue:
			o.scheduled, o.scheduledFalseReason, o.scheduledFalseMessage = true, "", ""
		case corev1.ConditionFalse:
			o.scheduled, o.scheduledFalseReason, o.scheduledFalseMessage = false, c.Reason, c.Message
		}
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Name != mainContainer {
			continue
		}
		o.containerWaiting = ""
		if cs.State.Waiting != nil {
			o.containerWaiting = cs.State.Waiting.Reason
		}
		o.containerRunning = cs.State.Running != nil
		o.containerReady = cs.Ready
	}
}

var nominatedNodeClaim = regexp.MustCompile(`nodeclaim/([\w-]+)`)

func (o *observed) applyEvents(events []corev1.Event) {
	var latest time.Time
	for _, e := range events {
		if e.InvolvedObject.Kind != "Pod" || e.InvolvedObject.Name != o.podName {
			continue
		}
		switch e.Reason {
		case "Pulling":
			o.hasPulling = true
		case "Pulled":
			o.hasPulling, o.hasPulled = true, true
		case "FailedScheduling":
			o.failedSchedulingSeen = true
			if at := eventTime(e); !at.Before(latest) {
				latest = at
				o.failedSchedulingReason = e.Message
			}
		case "Nominated":
			// Karpenter: "Pod should schedule on: nodeclaim/sandbox-fr6gf".
			if m := nominatedNodeClaim.FindStringSubmatch(e.Message); m != nil {
				o.nominatedNodeClaim = m[1]
			}
		}
	}
}

func eventTime(e corev1.Event) time.Time {
	if !e.LastTimestamp.IsZero() {
		return e.LastTimestamp.Time
	}
	return e.EventTime.Time
}

// derivePhase is the most specific phase the observation supports; the first
// matching rule wins.
func derivePhase(o *observed, now time.Time) protocol.Phase {
	since := o.startedAt.UnixMilli()
	if o.claimReady {
		return protocol.Phase{Kind: protocol.PhaseReady}
	}
	switch o.containerWaiting {
	case "ImagePullBackOff", "ErrImagePull":
		return protocol.Phase{Kind: protocol.PhaseFailed, Reason: protocol.FailureImagePullBackoff,
			Message: "Sandbox image failed to download. The cluster may be missing pull credentials or the image tag may not exist."}
	case "CrashLoopBackOff":
		return protocol.Phase{Kind: protocol.PhaseFailed, Reason: protocol.FailureCrashLoopBackoff,
			Message: "Sandbox crashed during startup and is now in CrashLoopBackOff. Check pod logs."}
	}
	// Only a timeout with a FailedScheduling seen: a slow PodScheduled=True
	// alone is not one.
	if !o.scheduled && o.failedSchedulingSeen && now.Sub(o.startedAt) > schedulingTimeout {
		msg := o.failedSchedulingReason
		if msg == "" {
			msg = fmt.Sprintf("Pod could not be scheduled within %ds.", int(schedulingTimeout.Seconds()))
		}
		return protocol.Phase{Kind: protocol.PhaseFailed, Reason: protocol.FailureSchedulingTimeout, Message: msg}
	}
	if o.containerRunning && !o.containerReady {
		return protocol.Phase{Kind: protocol.PhaseWarmingDaemon, Since: since}
	}
	if o.hasPulling && !o.hasPulled {
		return protocol.Phase{Kind: protocol.PhasePullingImage, Since: since}
	}
	if o.containerWaiting == "ContainerCreating" || o.containerWaiting == "PodInitializing" || (o.scheduled && !o.containerRunning) {
		return protocol.Phase{Kind: protocol.PhaseStartingContainer, Since: since}
	}
	if o.scheduledFalseReason == corev1.PodReasonUnschedulable || (o.failedSchedulingSeen && !o.scheduled) {
		msg := o.failedSchedulingReason
		if msg == "" {
			msg = o.scheduledFalseMessage
		}
		return protocol.Phase{Kind: protocol.PhaseWaitingForCapacity, Since: since, Message: msg, NodeClaim: o.nominatedNodeClaim}
	}
	return protocol.Phase{Kind: protocol.PhaseClaiming, Since: since}
}

func terminal(p protocol.Phase) bool {
	return p.Kind == protocol.PhaseReady || p.Kind == protocol.PhaseFailed
}

// phaseRank orders non-terminal phases so a transient observation (a
// container briefly terminated between restarts) never regresses the stream.
func phaseRank(k protocol.PhaseKind) int {
	switch k {
	case protocol.PhaseWaitingForCapacity:
		return 1
	case protocol.PhasePullingImage:
		return 2
	case protocol.PhaseStartingContainer:
		return 3
	case protocol.PhaseWarmingDaemon:
		return 4
	}
	return 0
}

// phaseKey dedupes consecutive phases; capacity diagnostics re-emit when they
// change.
func phaseKey(p protocol.Phase) string {
	switch p.Kind {
	case protocol.PhaseWaitingForCapacity:
		return fmt.Sprintf("%s:%s:%s", p.Kind, p.Message, p.NodeClaim)
	case protocol.PhaseFailed:
		return fmt.Sprintf("%s:%s:%s", p.Kind, p.Reason, p.Message)
	}
	return string(p.Kind)
}

// observe refreshes o from the claim, its newest labelled pod and that pod's
// events. Read failures leave the previous observation in place: a transient
// API error must not end a watch.
func (r *Runner) observe(ctx context.Context, handle string, o *observed) {
	if c, err := r.kube.getClaim(ctx, handle); err == nil && c != nil {
		o.claimReady = c.ready()
	}
	pod, err := r.kube.newestPod(ctx, handle)
	if err != nil || pod == nil {
		return
	}
	o.applyPod(pod)
	events, err := r.kube.core.CoreV1().Events(r.kube.namespace).List(ctx, metav1.ListOptions{
		FieldSelector: "involvedObject.kind=Pod,involvedObject.name=" + pod.Name,
	})
	if err == nil {
		o.applyEvents(events.Items)
	}
}

// Watch streams the claim's pre-ready phases, deduped and never regressing,
// and closes after a terminal one. Safe before the claim exists: it stays at
// claiming until the operator creates the pod.
func (r *Runner) Watch(ctx context.Context, handle string) (<-chan protocol.Phase, error) {
	out := make(chan protocol.Phase, 8)
	go func() {
		defer close(out)
		o := &observed{startedAt: r.now()}
		lastKey, highest := "", -1
		emit := func(p protocol.Phase) bool {
			select {
			case out <- p:
				return true
			case <-ctx.Done():
				return false
			}
		}
		for first := true; ; first = false {
			if !first {
				if daemonclient.Sleep(ctx, r.timing.watchPoll) != nil {
					return
				}
				r.observe(ctx, handle, o)
			}
			p := derivePhase(o, r.now())
			key := phaseKey(p)
			if terminal(p) {
				if key != lastKey {
					emit(p)
				}
				return
			}
			rank := phaseRank(p.Kind)
			if rank < highest || key == lastKey {
				continue
			}
			lastKey, highest = key, rank
			if !emit(p) {
				return
			}
		}
	}()
	return out, nil
}

// waitReady returns once the claim is ready, fails on a terminal failure, and
// otherwise only after the stall timeout passes without a new phase.
func (r *Runner) waitReady(ctx context.Context, handle string) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	phases, err := r.Watch(ctx, handle)
	if err != nil {
		return err
	}
	return waitReadyOn(ctx, phases, r.timing.stall)
}

func waitReadyOn(ctx context.Context, phases <-chan protocol.Phase, stall time.Duration) error {
	current := protocol.PhaseClaiming
	timer := time.NewTimer(stall)
	defer timer.Stop()
	for {
		select {
		case p, ok := <-phases:
			if !ok {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				return fmt.Errorf("phase stream ended before the sandbox was ready (last: %s)", current)
			}
			switch p.Kind {
			case protocol.PhaseReady:
				return nil
			case protocol.PhaseFailed:
				return &runtime.Error{Code: protocol.ErrClaimFailed, Message: p.Message}
			}
			current = p.Kind
			timer.Reset(stall)
		case <-timer.C:
			return &runtime.Error{Code: protocol.ErrClaimStalled,
				Message: fmt.Sprintf("Sandbox did not become ready: no progress for %ds while %s", int(stall.Seconds()), current)}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
