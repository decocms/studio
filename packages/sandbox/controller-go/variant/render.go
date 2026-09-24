// Package variant reconciles SandboxVariants into the SandboxTemplates and
// SandboxWarmPools a claim for that variant resolves to.
package variant

import (
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
)

var (
	TemplateGVK = schema.GroupVersionKind{Group: "extensions.agents.x-k8s.io", Version: "v1alpha1", Kind: "SandboxTemplate"}
	PoolGVK     = schema.GroupVersionKind{Group: "extensions.agents.x-k8s.io", Version: "v1alpha1", Kind: "SandboxWarmPool"}
)

const (
	// The container Studio's daemon runs in; the only one whose resources a
	// variant changes. Init containers reusing the image get the image only.
	sandboxContainer = "sandbox"
	mediumSuffix     = "-medium"

	LabelVariant   = "sandbox.deco.cx/variant"
	LabelManagedBy = "app.kubernetes.io/managed-by"
	ManagedBy      = "sandbox-controller"
)

// Labels a rendered object must NOT inherit from its base: they would tell
// Helm or Argo CD the object is theirs, and Argo prunes what it tracks but
// did not render.
var foreignLabels = map[string]bool{
	LabelManagedBy:               true,
	"app.kubernetes.io/instance": true,
	"helm.sh/chart":              true,
}

// sandboxImage returns the image of the base template's sandbox container.
func sandboxImage(base *unstructured.Unstructured) (string, error) {
	containers, _, err := unstructured.NestedSlice(base.Object, "spec", "podTemplate", "spec", "containers")
	if err != nil {
		return "", err
	}
	for _, c := range containers {
		m, ok := c.(map[string]any)
		if ok && m["name"] == sandboxContainer {
			if img, ok := m["image"].(string); ok && img != "" {
				return img, nil
			}
		}
	}
	return "", fmt.Errorf("template %s has no %q container image", base.GetName(), sandboxContainer)
}

// ImageTag is the tag of an image reference, "" when it has none.
func ImageTag(ref string) string {
	if i := strings.LastIndex(ref, ":"); i > strings.LastIndex(ref, "/") {
		return ref[i+1:]
	}
	return ""
}

// RenderTemplate copies base, changing only what a variant may change: name,
// image, sandbox-container resources, scheduling and emptyDir sizes. Anything
// else (security context, mounts, env, ports) comes from the live base, so a
// variant cannot drift from it.
func RenderTemplate(base *unstructured.Unstructured, v *v1alpha1.SandboxVariant, name string) (*unstructured.Unstructured, error) {
	baseImage, err := sandboxImage(base)
	if err != nil {
		return nil, err
	}
	podSpecObj, found, err := unstructured.NestedMap(base.Object, "spec", "podTemplate", "spec")
	if err != nil || !found {
		return nil, fmt.Errorf("template %s: no spec.podTemplate.spec", base.GetName())
	}
	var pod corev1.PodSpec
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(podSpecObj, &pod); err != nil {
		return nil, fmt.Errorf("template %s: %w", base.GetName(), err)
	}

	image := v.Spec.Image.Repository + ":" + v.Spec.Image.Tag
	for i := range pod.InitContainers {
		if pod.InitContainers[i].Image == baseImage {
			pod.InitContainers[i].Image = image
		}
	}
	for i := range pod.Containers {
		c := &pod.Containers[i]
		if c.Image == baseImage {
			c.Image = image
		}
		if c.Name == sandboxContainer {
			c.Resources.Limits = mergeResources(c.Resources.Limits, v.Spec.Resources.Limits)
			c.Resources.Requests = mergeResources(c.Resources.Requests, v.Spec.Resources.Requests)
		}
	}
	if len(v.Spec.NodeSelector) > 0 {
		pod.NodeSelector = v.Spec.NodeSelector
	}
	if len(v.Spec.Tolerations) > 0 {
		pod.Tolerations = v.Spec.Tolerations
	}
	for i := range pod.Volumes {
		vol := &pod.Volumes[i]
		if size, ok := v.Spec.VolumeSizes[vol.Name]; ok && vol.EmptyDir != nil {
			vol.EmptyDir.SizeLimit = &size
		}
	}

	podObj, err := runtime.DefaultUnstructuredConverter.ToUnstructured(&pod)
	if err != nil {
		return nil, err
	}
	spec, _, _ := unstructured.NestedMap(base.Object, "spec")
	out := &unstructured.Unstructured{Object: map[string]any{"spec": spec}}
	if err := unstructured.SetNestedMap(out.Object, podObj, "spec", "podTemplate", "spec"); err != nil {
		return nil, err
	}
	out.SetGroupVersionKind(TemplateGVK)
	out.SetName(name)
	out.SetNamespace(v.Namespace)
	out.SetLabels(renderedLabels(base.GetLabels(), v))
	return out, nil
}

// RenderPool mirrors the chart's pools: named like their template, and
// OnReplenish so a template change drains stale pods by adoption instead of
// restarting the pool.
func RenderPool(v *v1alpha1.SandboxVariant, name string, replicas int32, baseLabels map[string]string) *unstructured.Unstructured {
	out := &unstructured.Unstructured{Object: map[string]any{
		"spec": map[string]any{
			"replicas":           int64(replicas),
			"updateStrategy":     map[string]any{"type": "OnReplenish"},
			"sandboxTemplateRef": map[string]any{"name": name},
		},
	}}
	out.SetGroupVersionKind(PoolGVK)
	out.SetName(name)
	out.SetNamespace(v.Namespace)
	out.SetLabels(renderedLabels(baseLabels, v))
	return out
}

func renderedLabels(base map[string]string, v *v1alpha1.SandboxVariant) map[string]string {
	out := map[string]string{}
	for k, val := range base {
		if !foreignLabels[k] {
			out[k] = val
		}
	}
	out[LabelManagedBy] = ManagedBy
	out[LabelVariant] = v.Variant()
	return out
}

func mergeResources(base, over corev1.ResourceList) corev1.ResourceList {
	if len(over) == 0 {
		return base
	}
	out := corev1.ResourceList{}
	for k, q := range base {
		out[k] = q
	}
	for k, q := range over {
		out[k] = q
	}
	return out
}
