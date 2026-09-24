package agentsandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

// legacySSAFieldManager is the field manager Studio's in-process runner
// applied the Service port and the HTTPRoute under. Kubernetes tracks
// ownership per field by this string, so keeping it makes the controller's
// first apply after cutover a no-op instead of a conflict.
const legacySSAFieldManager = "mesh-sandbox-runner"

const (
	daemonPort = 9000
	// mainContainer is the agent container; siblings are the org-fs sidecar
	// and init containers.
	mainContainer = "sandbox"
)

var errClaimExists = errors.New("SandboxClaim already exists")

type kube struct {
	dyn       dynamic.Interface
	core      kubernetes.Interface
	namespace string
}

func (k *kube) claims() dynamic.ResourceInterface {
	return k.dyn.Resource(ClaimGVR).Namespace(k.namespace)
}

func (k *kube) getClaim(ctx context.Context, name string) (*Claim, error) {
	u, err := k.claims().Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get SandboxClaim %s: %w", name, err)
	}
	var c Claim
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(u.Object, &c); err != nil {
		return nil, fmt.Errorf("decode SandboxClaim %s: %w", name, err)
	}
	return &c, nil
}

func (k *kube) createClaim(ctx context.Context, c *Claim) error {
	obj, err := runtime.DefaultUnstructuredConverter.ToUnstructured(c)
	if err != nil {
		return err
	}
	_, err = k.claims().Create(ctx, &unstructured.Unstructured{Object: obj}, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return errClaimExists
	}
	if err != nil {
		return fmt.Errorf("create SandboxClaim %s: %w", c.Name, err)
	}
	return nil
}

func (k *kube) deleteClaim(ctx context.Context, name string) error {
	err := k.claims().Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete SandboxClaim %s: %w", name, err)
	}
	return nil
}

// patchShutdown moves the claim's reap time. Merge patch: the one field the
// operator does not otherwise own. A claim deleted since the lookup is fine.
func (k *kube) patchShutdown(ctx context.Context, name string, at time.Time) error {
	body, err := json.Marshal(map[string]any{
		"spec": map[string]any{"lifecycle": map[string]any{
			"shutdownPolicy": "Delete",
			"shutdownTime":   at.UTC().Format(time.RFC3339),
		}},
	})
	if err != nil {
		return err
	}
	_, err = k.claims().Patch(ctx, name, types.MergePatchType, body, metav1.PatchOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("patch SandboxClaim %s shutdownTime: %w", name, err)
	}
	return nil
}

func (k *kube) templateExists(ctx context.Context, name string) (bool, error) {
	_, err := k.dyn.Resource(TemplateGVR).Namespace(k.namespace).Get(ctx, name, metav1.GetOptions{})
	// Absent and unreadable have the same consequence: a claim naming it would
	// sit at TemplateNotFound.
	if apierrors.IsNotFound(err) || apierrors.IsForbidden(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("get SandboxTemplate %s: %w", name, err)
	}
	return true, nil
}

// ensureServicePort applies port 9000 onto the operator's per-Sandbox
// Service, which the operator ships with no ports. Nothing routes through a
// ports-less Service (kube-proxy programs no rule, Envoy builds no cluster),
// and Service DNS is how the daemon is reached whenever previewUrlPattern is
// set, gateway or not. force: the operator set ports under its own manager,
// and without it the first apply 409s.
func (k *kube) ensureServicePort(ctx context.Context, service string) error {
	body, err := json.Marshal(map[string]any{
		"apiVersion": "v1",
		"kind":       "Service",
		"metadata":   map[string]any{"name": service},
		"spec": map[string]any{"ports": []any{map[string]any{
			"name": "daemon", "port": daemonPort, "targetPort": daemonPort, "protocol": "TCP",
		}}},
	})
	if err != nil {
		return err
	}
	force := true
	_, err = k.core.CoreV1().Services(k.namespace).Patch(ctx, service, types.ApplyPatchType, body,
		metav1.PatchOptions{FieldManager: legacySSAFieldManager, Force: &force})
	if err != nil {
		return fmt.Errorf("apply Service ports on %s: %w", service, err)
	}
	return nil
}

// applyHTTPRoute upserts the per-claim route. Server-Side Apply is idempotent
// and re-points a changed backendRef; force takes the fields over from the
// in-process runner's apply without a 409 that would leave the route with no
// backend.
func (k *kube) applyHTTPRoute(ctx context.Context, route map[string]any) error {
	body, err := json.Marshal(route)
	if err != nil {
		return err
	}
	name := route["metadata"].(map[string]any)["name"].(string)
	force := true
	_, err = k.dyn.Resource(HTTPRouteGVR).Namespace(k.namespace).Patch(ctx, name, types.ApplyPatchType, body,
		metav1.PatchOptions{FieldManager: legacySSAFieldManager, Force: &force})
	if err != nil {
		return fmt.Errorf("apply HTTPRoute %s: %w", name, err)
	}
	return nil
}

func (k *kube) deleteHTTPRoute(ctx context.Context, name string) error {
	err := k.dyn.Resource(HTTPRouteGVR).Namespace(k.namespace).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete HTTPRoute %s: %w", name, err)
	}
	return nil
}

// newestPod is the most recent pod carrying the handle label: a continuation
// reuses the handle, so an earlier attempt's corpse may carry it too.
func (k *kube) newestPod(ctx context.Context, handle string) (*corev1.Pod, error) {
	pods, err := k.core.CoreV1().Pods(k.namespace).List(ctx, metav1.ListOptions{LabelSelector: labelSandboxHandle + "=" + handle})
	if err != nil {
		return nil, err
	}
	var newest *corev1.Pod
	for i := range pods.Items {
		p := &pods.Items[i]
		if newest == nil || p.CreationTimestamp.After(newest.CreationTimestamp.Time) {
			newest = p
		}
	}
	return newest, nil
}

// lastTermination reads the kubelet's verdict on the handle's pod, the only
// place an OOM kill is recorded. Nil means "no longer knowable", never "not an
// OOM": the operator deletes the pod shortly after.
func (k *kube) lastTermination(ctx context.Context, handle string) *protocol.PodTermination {
	pod, err := k.newestPod(ctx, handle)
	if err != nil || pod == nil {
		return nil
	}
	return podTermination(pod)
}

func podTermination(pod *corev1.Pod) *protocol.PodTermination {
	var term *corev1.ContainerStateTerminated
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Name != mainContainer {
			continue
		}
		term = cs.State.Terminated
		if term == nil {
			term = cs.LastTerminationState.Terminated
		}
	}
	if term == nil || term.Reason == "" {
		// An eviction lands on the pod, and its containers often record no
		// terminated state at all.
		if pod.Status.Reason == "Evicted" {
			return &protocol.PodTermination{Reason: "Evicted", EvictionMessage: pod.Status.Message}
		}
		return nil
	}
	exit := term.ExitCode
	out := &protocol.PodTermination{Reason: term.Reason, OOMKilled: term.Reason == "OOMKilled", ExitCode: &exit}
	for _, c := range pod.Spec.Containers {
		if c.Name != mainContainer {
			continue
		}
		if lim, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
			out.MemoryLimit = lim.String()
		}
	}
	return out
}

// schedulable is the scheduler's own verdict: false while any pod in the
// namespace is Pending as Unschedulable. A lagging signal by one admission,
// which is the point: one run pays the wait instead of eight.
func (k *kube) schedulable(ctx context.Context) (bool, error) {
	pods, err := k.core.CoreV1().Pods(k.namespace).List(ctx, metav1.ListOptions{FieldSelector: "status.phase=Pending"})
	if err != nil {
		return true, err
	}
	for _, pod := range pods.Items {
		if pod.Status.Phase != corev1.PodPending {
			continue
		}
		for _, c := range pod.Status.Conditions {
			if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse && c.Reason == corev1.PodReasonUnschedulable {
				return false, nil
			}
		}
	}
	return true, nil
}
