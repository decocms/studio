package agentsandbox

import (
	"context"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/decocms/studio/sandbox-controller/protocol"
	"github.com/decocms/studio/sandbox-controller/runtime"
)

// Watch surfaces the pre-Ready window. Scheduling, image pulls and node
// provisioning can each take many seconds here, and surfacing them turns a
// black hole into a progress bar. The stream closes on a terminal phase.
func (r *Runner) Watch(ctx context.Context, handle string) (<-chan runtime.Phase, error) {
	out := make(chan runtime.Phase, 8)
	go func() {
		defer close(out)
		since := time.Now().UnixMilli()
		emit := func(p runtime.Phase) bool {
			p.Since = since
			select {
			case out <- p:
				return true
			case <-ctx.Done():
				return false
			}
		}
		if !emit(runtime.Phase{Kind: "claiming"}) {
			return
		}

		last := "claiming"
		deadline := time.Now().Add(readyTimeout)
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}

			phase, terminal := r.observePhase(ctx, handle)
			if phase.Kind != last {
				last = phase.Kind
				if !emit(phase) {
					return
				}
			}
			if terminal {
				return
			}
			if time.Now().After(deadline) {
				emit(runtime.Phase{
					Kind:    "failed",
					Reason:  "scheduling-timeout",
					Message: "sandbox did not become ready in time",
				})
				return
			}
		}
	}()
	return out, nil
}

// observePhase reads the claim, its bound Sandbox and the pod, and reports the
// most specific phase it can. Nothing here is a guess: each phase corresponds
// to a state the API server is actually reporting.
func (r *Runner) observePhase(ctx context.Context, handle string) (runtime.Phase, bool) {
	claim, err := r.getClaim(ctx, handle)
	if err != nil || claim == nil {
		return runtime.Phase{Kind: "claiming"}, false
	}
	adopted := claim.Status.SandboxStatus.Name
	if adopted == "" {
		return runtime.Phase{Kind: "claiming"}, false
	}
	if ready, _ := r.sandboxReady(ctx, adopted); ready {
		return runtime.Phase{Kind: "ready"}, true
	}
	podName, err := r.podNameFor(ctx, adopted)
	if err != nil {
		return runtime.Phase{Kind: "claiming"}, false
	}
	pod, err := r.core.CoreV1().Pods(r.namespace).Get(ctx, podName, metav1.GetOptions{})
	if err != nil {
		return runtime.Phase{Kind: "claiming"}, false
	}
	return podPhase(pod)
}

func podPhase(pod *corev1.Pod) (runtime.Phase, bool) {
	if pod.Status.Phase == corev1.PodPending {
		for _, c := range pod.Status.Conditions {
			if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse {
				return runtime.Phase{
					Kind:    "waiting-for-capacity",
					Message: c.Message,
				}, false
			}
		}
	}
	for _, cs := range append(pod.Status.InitContainerStatuses, pod.Status.ContainerStatuses...) {
		w := cs.State.Waiting
		if w == nil {
			continue
		}
		switch {
		case w.Reason == "ImagePullBackOff" || w.Reason == "ErrImagePull":
			return runtime.Phase{Kind: "failed", Reason: "image-pull-backoff", Message: w.Message}, true
		case w.Reason == "CrashLoopBackOff":
			return runtime.Phase{Kind: "failed", Reason: "crash-loop-backoff", Message: w.Message}, true
		case strings.Contains(w.Reason, "Pulling") || w.Reason == "PodInitializing":
			return runtime.Phase{Kind: "pulling-image"}, false
		}
	}
	if pod.Status.Phase == corev1.PodRunning {
		return runtime.Phase{Kind: "warming-daemon"}, false
	}
	return runtime.Phase{Kind: "starting-container"}, false
}

// LastTermination reads the kubelet's own verdict on the pod. This is the only
// place an OOM kill is recorded: the kernel SIGKILLs at the cgroup limit, so
// the dying sandbox reports nothing and studio just sees the stream break.
//
// Best-effort and racy against the pod's own deletion — nil means "cannot
// tell", so callers must degrade to their unqualified message.
func (r *Runner) LastTermination(ctx context.Context, handle string) (*protocol.PodTermination, error) {
	pods, err := r.core.CoreV1().Pods(r.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: labelSandboxHandle + "=" + handle,
	})
	if err != nil || len(pods.Items) == 0 {
		return nil, err
	}
	pod := pods.Items[0]
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Name != mainContainer {
			continue
		}
		term := cs.State.Terminated
		if term == nil {
			term = cs.LastTerminationState.Terminated
		}
		if term == nil || term.Reason == "" {
			return nil, nil
		}
		out := &protocol.PodTermination{
			Reason:    term.Reason,
			OOMKilled: term.Reason == "OOMKilled",
		}
		exit := term.ExitCode
		out.ExitCode = &exit
		for _, c := range pod.Spec.Containers {
			if c.Name == mainContainer {
				if lim, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
					out.MemoryLimit = lim.String()
				}
			}
		}
		return out, nil
	}
	return nil, nil
}

// Schedulable asks the scheduler's own verdict — "nothing is currently
// unschedulable" — rather than forecasting from node capacity. A false parks
// the caller instead of claiming a sandbox that would sit Pending until the
// readiness timeout fails the run.
func (r *Runner) Schedulable(ctx context.Context) (bool, error) {
	pods, err := r.core.CoreV1().Pods(r.namespace).List(ctx, metav1.ListOptions{
		FieldSelector: "status.phase=Pending",
	})
	if err != nil {
		return true, err
	}
	for _, pod := range pods.Items {
		for _, c := range pod.Status.Conditions {
			if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse && c.Reason == corev1.PodReasonUnschedulable {
				return false, nil
			}
		}
	}
	return true, nil
}
