package variant

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
)

const (
	FieldOwner       = "sandbox-controller"
	baseTemplateKey  = "spec.baseTemplate"
	registryRetry    = time.Minute
	helmKeepPolicy   = "helm.sh/resource-policy"
	helmManagedValue = "Helm"
)

type Reconciler struct {
	client.Client
	// Uncached, for imagePullSecrets: `get` by name, no cluster-wide secret watch.
	APIReader   client.Reader
	ImageExists ImageExists
}

func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := mgr.GetFieldIndexer().IndexField(context.Background(), &v1alpha1.SandboxVariant{}, baseTemplateKey,
		func(o client.Object) []string { return []string{o.(*v1alpha1.SandboxVariant).Spec.BaseTemplate} }); err != nil {
		return err
	}
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.SandboxVariant{}).
		Owns(newObject(TemplateGVK)).
		Owns(newObject(PoolGVK)).
		// A base template change re-renders every variant built on it.
		Watches(newObject(TemplateGVK), handler.EnqueueRequestsFromMapFunc(r.variantsOfBase)).
		Complete(r)
}

func (r *Reconciler) variantsOfBase(ctx context.Context, o client.Object) []reconcile.Request {
	var out []reconcile.Request
	bases := []string{o.GetName()}
	if trimmed := strings.TrimSuffix(o.GetName(), mediumSuffix); trimmed != o.GetName() {
		bases = append(bases, trimmed)
	}
	for _, base := range bases {
		var list v1alpha1.SandboxVariantList
		if err := r.List(ctx, &list, client.InNamespace(o.GetNamespace()), client.MatchingFields{baseTemplateKey: base}); err != nil {
			log.FromContext(ctx).Error(err, "listing variants of base", "base", base)
			continue
		}
		for _, v := range list.Items {
			out = append(out, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: v.Namespace, Name: v.Name}})
		}
	}
	return out
}

func (r *Reconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	var v v1alpha1.SandboxVariant
	if err := r.Get(ctx, req.NamespacedName, &v); err != nil {
		// Deleted: the rendered objects go with it through their ownerReferences.
		return reconcile.Result{}, client.IgnoreNotFound(err)
	}
	orig := v.DeepCopy()
	result, err := r.reconcile(ctx, &v)
	v.Status.ObservedGeneration = v.Generation
	// A patch, not an Update: the controller is status's only writer, so a
	// spec edit racing the reconcile must not fail the write.
	if uerr := r.Status().Patch(ctx, &v, client.MergeFrom(orig)); uerr != nil && err == nil {
		err = uerr
	}
	return result, err
}

func (r *Reconciler) reconcile(ctx context.Context, v *v1alpha1.SandboxVariant) (reconcile.Result, error) {
	names := renderedNames(v)
	r.setReady(ctx, v, names)

	bases := map[string]*unstructured.Unstructured{}
	for _, base := range []string{v.Spec.BaseTemplate, v.Spec.BaseTemplate + mediumSuffix} {
		u := newObject(TemplateGVK)
		if err := r.Get(ctx, client.ObjectKey{Namespace: v.Namespace, Name: base}, u); err != nil {
			if apierrors.IsNotFound(err) {
				setCondition(v, v1alpha1.ConditionRendered, false, "BaseTemplateMissing", fmt.Sprintf("SandboxTemplate %s not found", base))
				return reconcile.Result{}, nil
			}
			return reconcile.Result{}, err
		}
		bases[base] = u
	}
	baseImage, err := sandboxImage(bases[v.Spec.BaseTemplate])
	if err != nil {
		setCondition(v, v1alpha1.ConditionRendered, false, "BaseTemplateInvalid", err.Error())
		return reconcile.Result{}, nil
	}
	v.Status.DefaultTemplateTag = ImageTag(baseImage)

	// A template whose image does not exist is ImagePullBackOff at claim time,
	// not a clean degrade, so this is checked before anything is written.
	kc, err := r.keychain(ctx, bases[v.Spec.BaseTemplate])
	if err != nil {
		setCondition(v, v1alpha1.ConditionImageAvailable, false, "PullSecretInvalid", err.Error())
		setCondition(v, v1alpha1.ConditionRendered, false, "ImageUnchecked", "previous render kept")
		return reconcile.Result{}, nil
	}
	image := v.Spec.Image.Repository + ":" + v.Spec.Image.Tag
	exists, err := r.ImageExists(ctx, image, kc)
	switch {
	case err != nil:
		setUnknown(v, v1alpha1.ConditionImageAvailable, "RegistryError", err.Error())
		setCondition(v, v1alpha1.ConditionRendered, false, "ImageUnchecked", "previous render kept")
		return reconcile.Result{RequeueAfter: registryRetry}, nil
	case !exists:
		setCondition(v, v1alpha1.ConditionImageAvailable, false, "ImageNotFound", image+" not found")
		setCondition(v, v1alpha1.ConditionRendered, false, "ImageNotFound", "previous render kept")
		return reconcile.Result{}, nil
	}
	setCondition(v, v1alpha1.ConditionImageAvailable, true, "Found", image)

	var objs []*unstructured.Unstructured
	for i, name := range names.templates {
		t, err := RenderTemplate(bases[names.bases[i]], v, name)
		if err != nil {
			setCondition(v, v1alpha1.ConditionRendered, false, "BaseTemplateInvalid", err.Error())
			return reconcile.Result{}, nil
		}
		objs = append(objs, t)
	}
	baseLabels := bases[v.Spec.BaseTemplate].GetLabels()
	objs = append(objs,
		RenderPool(v, names.templates[0], v.Spec.WarmPool.Size, baseLabels),
		RenderPool(v, names.templates[1], v.Spec.WarmPool.MediumSize, baseLabels))

	for _, o := range objs {
		if msg, err := r.claim(ctx, v, o); err != nil {
			return reconcile.Result{}, err
		} else if msg != "" {
			setCondition(v, v1alpha1.ConditionRendered, false, "Conflict", msg)
			return reconcile.Result{}, nil
		}
	}
	for _, o := range objs {
		if err := controllerutil.SetControllerReference(v, o, r.Scheme()); err != nil {
			return reconcile.Result{}, err
		}
		if err := r.Apply(ctx, client.ApplyConfigurationFromUnstructured(o), client.FieldOwner(FieldOwner), client.ForceOwnership); err != nil {
			return reconcile.Result{}, fmt.Errorf("apply %s %s: %w", o.GetKind(), o.GetName(), err)
		}
	}
	v.Status.Templates = names.templates
	setCondition(v, v1alpha1.ConditionRendered, true, "Rendered", "")
	setCondition(v, v1alpha1.ConditionReady, true, "Rendered", "")
	return reconcile.Result{}, nil
}

// claim decides whether o's name is ours to write, adopting a chart-rendered
// object the chart has let go of. A non-empty message means "not ours".
func (r *Reconciler) claim(ctx context.Context, v *v1alpha1.SandboxVariant, o *unstructured.Unstructured) (string, error) {
	live := newObject(o.GroupVersionKind())
	if err := r.Get(ctx, client.ObjectKeyFromObject(o), live); err != nil {
		return "", client.IgnoreNotFound(err)
	}
	if owner := metav1.GetControllerOf(live); owner != nil {
		if owner.UID == v.UID {
			return "", nil
		}
		return fmt.Sprintf("%s %s is controlled by %s %s", o.GetKind(), o.GetName(), owner.Kind, owner.Name), nil
	}
	if live.GetLabels()[LabelManagedBy] == helmManagedValue && live.GetAnnotations()[helmKeepPolicy] != "keep" {
		return fmt.Sprintf("%s %s is still rendered by Helm; set %s: keep on it first", o.GetKind(), o.GetName(), helmKeepPolicy), nil
	}
	// Adopting: drop what tells Helm or Argo CD the object is theirs. SSA
	// leaves fields another manager set, so this cannot ride on the apply.
	labels := map[string]any{}
	for k := range live.GetLabels() {
		if foreignLabels[k] && k != LabelManagedBy {
			labels[k] = nil
		}
	}
	annotations := map[string]any{}
	for k := range live.GetAnnotations() {
		if strings.HasPrefix(k, "meta.helm.sh/") || k == helmKeepPolicy ||
			strings.HasPrefix(k, "argocd.argoproj.io/") || k == corev1.LastAppliedConfigAnnotation {
			annotations[k] = nil
		}
	}
	if len(labels) == 0 && len(annotations) == 0 {
		return "", nil
	}
	body, err := json.Marshal(map[string]any{"metadata": map[string]any{"labels": labels, "annotations": annotations}})
	if err != nil {
		return "", err
	}
	return "", r.Patch(ctx, live, client.RawPatch(types.MergePatchType, body))
}

type rendered struct {
	templates []string // <v>, <v>-medium; pools share the names
	bases     []string
}

func renderedNames(v *v1alpha1.SandboxVariant) rendered {
	return rendered{
		templates: []string{v.Name, v.Name + mediumSuffix},
		bases:     []string{v.Spec.BaseTemplate, v.Spec.BaseTemplate + mediumSuffix},
	}
}

// setReady: a claim can use the variant iff both templates exist and are
// ours — whether from this render or a previous one.
func (r *Reconciler) setReady(ctx context.Context, v *v1alpha1.SandboxVariant, names rendered) {
	for _, name := range names.templates {
		u := newObject(TemplateGVK)
		err := r.Get(ctx, client.ObjectKey{Namespace: v.Namespace, Name: name}, u)
		if err != nil || !metav1.IsControlledBy(u, v) {
			setCondition(v, v1alpha1.ConditionReady, false, "NotRendered", "template "+name+" not rendered")
			return
		}
	}
	setCondition(v, v1alpha1.ConditionReady, true, "Rendered", "")
}

func (r *Reconciler) keychain(ctx context.Context, base *unstructured.Unstructured) (pullSecretKeychain, error) {
	refs, _, _ := unstructured.NestedSlice(base.Object, "spec", "podTemplate", "spec", "imagePullSecrets")
	var configs [][]byte
	for _, ref := range refs {
		m, _ := ref.(map[string]any)
		name, _ := m["name"].(string)
		if name == "" {
			continue
		}
		var s corev1.Secret
		if err := r.APIReader.Get(ctx, client.ObjectKey{Namespace: base.GetNamespace(), Name: name}, &s); err != nil {
			return nil, fmt.Errorf("imagePullSecret %s: %w", name, err)
		}
		if raw, ok := s.Data[corev1.DockerConfigJsonKey]; ok {
			configs = append(configs, raw)
		}
	}
	return keychainFromDockerConfigs(configs)
}

func newObject(gvk schema.GroupVersionKind) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetGroupVersionKind(gvk)
	return u
}

func setCondition(v *v1alpha1.SandboxVariant, t string, ok bool, reason, msg string) {
	status := metav1.ConditionFalse
	if ok {
		status = metav1.ConditionTrue
	}
	meta.SetStatusCondition(&v.Status.Conditions, metav1.Condition{Type: t, Status: status, Reason: reason, Message: msg, ObservedGeneration: v.Generation})
}

func setUnknown(v *v1alpha1.SandboxVariant, t, reason, msg string) {
	meta.SetStatusCondition(&v.Status.Conditions, metav1.Condition{Type: t, Status: metav1.ConditionUnknown, Reason: reason, Message: msg, ObservedGeneration: v.Generation})
}
