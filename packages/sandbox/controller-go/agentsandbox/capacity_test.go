package agentsandbox

import (
	"context"
	"errors"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sfake "k8s.io/client-go/kubernetes/fake"

	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
)

var kvm = map[string]string{"karpenter.sh/nodepool": "android-kvm"}

var kvmToleration = corev1.Toleration{Key: "deco.cx/kvm", Operator: corev1.TolerationOpExists, Effect: corev1.TaintEffectNoSchedule}

func pendingPod(name, reason string, nodeSelector map[string]string, tolerations ...corev1.Toleration) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec:       corev1.PodSpec{NodeSelector: nodeSelector, Tolerations: tolerations},
		Status: corev1.PodStatus{Phase: corev1.PodPending,
			Conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: reason}}},
	}
}

func sandboxVariant(name, base string, ready bool, nodeSelector map[string]string, tolerations ...corev1.Toleration) v1alpha1.SandboxVariant {
	v := v1alpha1.SandboxVariant{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec:       v1alpha1.SandboxVariantSpec{BaseTemplate: base, NodeSelector: nodeSelector, Tolerations: tolerations},
	}
	if ready {
		v.Status.Conditions = []metav1.Condition{{Type: v1alpha1.ConditionReady, Status: metav1.ConditionTrue}}
	}
	return v
}

// capacity.test.ts's cases, through the namespace listing.
func TestUnschedulablePods(t *testing.T) {
	running := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "running", Namespace: ns}, Status: corev1.PodStatus{Phase: corev1.PodRunning}}
	scheduled := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "pulling", Namespace: ns}, Status: corev1.PodStatus{Phase: corev1.PodPending,
		Conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionTrue}}}}
	for _, tc := range []struct {
		name string
		pods []*corev1.Pod
		want int
	}{
		// The verdict that failed eight tasks: the pod never became ready and
		// the run died after 180s.
		{"true for a pod the scheduler refused to place", []*corev1.Pod{pendingPod("p", corev1.PodReasonUnschedulable, nil)}, 1},
		// Pending with a node (pulling its image, an init container) is not a
		// capacity problem.
		{"false for a Pending pod that was already scheduled", []*corev1.Pod{scheduled}, 0},
		{"false for a running namespace", []*corev1.Pod{running}, 0},
		{"false for an empty list", nil, 0},
		{"false for a pod pending for another reason", []*corev1.Pod{pendingPod("gated", "SchedulingGated", nil)}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			core := k8sfake.NewSimpleClientset()
			for _, p := range tc.pods {
				_, _ = core.CoreV1().Pods(ns).Create(context.Background(), p, metav1.CreateOptions{})
			}
			got, err := (&kube{core: core, namespace: ns}).unschedulablePods(context.Background())
			if err != nil || len(got) != tc.want {
				t.Fatalf("got %d pods, err %v; want %d", len(got), err, tc.want)
			}
		})
	}
}

func TestSchedulableFor(t *testing.T) {
	const base = "studio-sandbox"
	android := sandboxVariant(base+"-android", base, true, kvm, kvmToleration)
	// On the default nodes: nothing to tell its pods apart by.
	slim := sandboxVariant(base+"-slim", base, true, nil)
	stgAndroid := sandboxVariant("studio-sandbox-stg-android", "studio-sandbox-stg", true, kvm, kvmToleration)
	variants := []v1alpha1.SandboxVariant{android, slim}

	general := pendingPod("general", corev1.PodReasonUnschedulable, map[string]string{"karpenter.sh/nodepool": "sandbox"})
	onKVM := pendingPod("kvm", corev1.PodReasonUnschedulable, kvm, kvmToleration)
	for _, tc := range []struct {
		name     string
		pods     []*corev1.Pod
		variants []v1alpha1.SandboxVariant
		image    string
		want     bool
	}{
		{"nothing unplaceable admits every image", nil, variants, "android", true},
		{"KVM nodes full, general nodes idle: android is unschedulable", []*corev1.Pod{onKVM}, variants, "android", false},
		{"KVM nodes full does not stop the default image", []*corev1.Pod{onKVM}, variants, "", true},
		{"general nodes full does not stop android", []*corev1.Pod{general}, variants, "android", true},
		{"general nodes full stops the default image", []*corev1.Pod{general}, variants, "default", false},
		{"a variant on the default nodes shares their verdict", []*corev1.Pod{general}, variants, "slim", false},
		{"an unknown image degrades to the default, and so does its verdict", []*corev1.Pod{onKVM}, variants, "ios", true},
		{"a variant that is not Ready degrades to the default", []*corev1.Pod{general},
			[]v1alpha1.SandboxVariant{sandboxVariant(base+"-android", base, false, kvm, kvmToleration)}, "android", false},
		// Environments share the namespace and the KVM nodes.
		{"another environment's variant pods still are not the default's", []*corev1.Pod{onKVM}, []v1alpha1.SandboxVariant{stgAndroid}, "", true},
		{"a pod with the selector but not the toleration is not on the variant's nodes",
			[]*corev1.Pod{pendingPod("half", corev1.PodReasonUnschedulable, kvm)}, variants, "android", true},
		{"without variants it is the namespace aggregate", []*corev1.Pod{onKVM}, nil, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var pods []corev1.Pod
			for _, p := range tc.pods {
				pods = append(pods, *p)
			}
			if got := schedulableFor(pods, tc.variants, base, tc.image); got != tc.want {
				t.Fatalf("schedulable = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestRunnerSchedulable(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns, Variants: func(context.Context) ([]v1alpha1.SandboxVariant, error) {
		return []v1alpha1.SandboxVariant{sandboxVariant("studio-sandbox-android", "studio-sandbox", true, kvm, kvmToleration)}, nil
	}})
	_, _ = h.core.CoreV1().Pods(ns).Create(context.Background(), pendingPod("kvm", corev1.PodReasonUnschedulable, kvm, kvmToleration), metav1.CreateOptions{})
	if ok, err := h.runner.Schedulable(context.Background(), "android"); ok || err != nil {
		t.Fatalf("android: %v %v", ok, err)
	}
	if ok, err := h.runner.Schedulable(context.Background(), ""); !ok || err != nil {
		t.Fatalf("default: %v %v", ok, err)
	}
	// Variants unreadable: the aggregate, not a blind admit.
	h.runner.cfg.Variants = func(context.Context) ([]v1alpha1.SandboxVariant, error) { return nil, errors.New("cache not synced") }
	if ok, _ := h.runner.Schedulable(context.Background(), ""); ok {
		t.Fatal("unreadable variants must fall back to the aggregate")
	}
}
