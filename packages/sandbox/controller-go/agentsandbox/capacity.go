package agentsandbox

import (
	"context"
	"log/slog"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
)

// Schedulable is "is anything that would share this image's nodes currently
// unplaceable?", never a forecast: re-implementing the scheduler's accounting
// would be wrong in a different way every release. It lags by one admission,
// which is the point: one run pays the scheduling wait instead of eight.
//
// A variant with its own nodeSelector or tolerations (android on KVM nodes)
// fills independently of the fleet, so an unplaceable pod counts only against
// the image whose nodes it targets. Without the variants to tell them apart
// it is the namespace aggregate.
func (r *Runner) Schedulable(ctx context.Context, image string) (bool, error) {
	pods, err := r.kube.unschedulablePods(ctx)
	if err != nil || len(pods) == 0 {
		return true, err
	}
	var variants []v1alpha1.SandboxVariant
	if r.cfg.Variants != nil {
		if variants, err = r.cfg.Variants(ctx); err != nil {
			slog.Warn("capacity: variants unreadable; judging the namespace aggregate", "err", err)
			variants = nil
		}
	}
	return schedulableFor(pods, variants, r.cfg.TemplateName, image), nil
}

// schedulableFor scopes unschedulable pods to image's nodes. The image's
// scope is its Ready variant's placement, when it has one; otherwise (the
// default image, a variant on the default nodes, one a claim would fall back
// from) it is every pod not targeting some variant's own nodes. That set
// takes variants of every base: environments share the namespace and nodes.
func schedulableFor(pods []corev1.Pod, variants []v1alpha1.SandboxVariant, base, image string) bool {
	var own []*v1alpha1.SandboxVariant
	var target *v1alpha1.SandboxVariant
	for i := range variants {
		v := &variants[i]
		if !hasPlacement(v) {
			continue
		}
		own = append(own, v)
		if !isDefaultImage(image) && v.Spec.BaseTemplate == base && v.Name == base+"-"+image && variantReady(v) {
			target = v
		}
	}
	for i := range pods {
		pod := &pods[i]
		if target != nil {
			if onVariantNodes(pod, target) {
				return false
			}
			continue
		}
		onVariant := false
		for _, v := range own {
			if onVariantNodes(pod, v) {
				onVariant = true
				break
			}
		}
		if !onVariant {
			return false
		}
	}
	return true
}

func hasPlacement(v *v1alpha1.SandboxVariant) bool {
	return len(v.Spec.NodeSelector) > 0 || len(v.Spec.Tolerations) > 0
}

func variantReady(v *v1alpha1.SandboxVariant) bool {
	for _, c := range v.Status.Conditions {
		if c.Type == v1alpha1.ConditionReady && c.Status == metav1.ConditionTrue {
			return true
		}
	}
	return false
}

// onVariantNodes: the pod asks for the variant's nodes. A rendered template
// replaces the base's nodeSelector and tolerations with the variant's, so its
// pods carry every entry of both.
func onVariantNodes(pod *corev1.Pod, v *v1alpha1.SandboxVariant) bool {
	for k, want := range v.Spec.NodeSelector {
		if got, ok := pod.Spec.NodeSelector[k]; !ok || got != want {
			return false
		}
	}
	for _, want := range v.Spec.Tolerations {
		found := false
		for _, got := range pod.Spec.Tolerations {
			if got.Key == want.Key && got.Operator == want.Operator && got.Value == want.Value && got.Effect == want.Effect {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
