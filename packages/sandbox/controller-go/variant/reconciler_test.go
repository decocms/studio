package variant

import (
	"context"
	"errors"
	"testing"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
)

const ns = "agent-sandbox-system"

type registry map[string]bool

func (r registry) exists(_ context.Context, ref string, _ authn.Keychain) (bool, error) {
	return r[ref], nil
}

func newReconciler(t *testing.T, images ImageExists, objs ...client.Object) (*Reconciler, client.Client) {
	t.Helper()
	scheme := runtime.NewScheme()
	_ = clientgoscheme.AddToScheme(scheme)
	_ = v1alpha1.AddToScheme(scheme)
	chart := chartTemplates(t)
	all := append([]client.Object{chart["studio-sandbox-prod"], chart["studio-sandbox-prod-medium"]}, objs...)
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(all...).
		WithStatusSubresource(&v1alpha1.SandboxVariant{}).
		WithIndex(&v1alpha1.SandboxVariant{}, baseTemplateKey, func(o client.Object) []string {
			return []string{o.(*v1alpha1.SandboxVariant).Spec.BaseTemplate}
		}).
		Build()
	return &Reconciler{Client: c, APIReader: c, ImageExists: images}, c
}

func reconcileVariant(t *testing.T, r *Reconciler, v *v1alpha1.SandboxVariant) (reconcile.Result, *v1alpha1.SandboxVariant) {
	t.Helper()
	res, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: client.ObjectKeyFromObject(v)})
	if err != nil {
		t.Fatal(err)
	}
	var got v1alpha1.SandboxVariant
	if err := r.Get(context.Background(), client.ObjectKeyFromObject(v), &got); err != nil {
		t.Fatal(err)
	}
	return res, &got
}

func template(t *testing.T, c client.Client, name string) *unstructured.Unstructured {
	t.Helper()
	u := newObject(TemplateGVK)
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: ns, Name: name}, u); err != nil {
		t.Fatalf("template %s: %v", name, err)
	}
	return u
}

func sandboxImageOf(t *testing.T, c client.Client, name string) string {
	t.Helper()
	img, err := sandboxImage(template(t, c, name))
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func condition(v *v1alpha1.SandboxVariant, typ string) metav1.ConditionStatus {
	if c := meta.FindStatusCondition(v.Status.Conditions, typ); c != nil {
		return c.Status
	}
	return ""
}

func TestRendersFourOwnedObjects(t *testing.T) {
	v := androidVariant(t)
	v.Spec.WarmPool = v1alpha1.WarmPool{Size: 2}
	r, c := newReconciler(t, registry{"ghcr.io/decocms/studio/studio-sandbox-android:1.0.0": true}.exists, v)
	_, got := reconcileVariant(t, r, v)

	for _, typ := range []string{v1alpha1.ConditionImageAvailable, v1alpha1.ConditionRendered, v1alpha1.ConditionReady} {
		if condition(got, typ) != metav1.ConditionTrue {
			t.Errorf("%s = %q, conditions %+v", typ, condition(got, typ), got.Status.Conditions)
		}
	}
	if got.Status.DefaultTemplateTag != "1.0.0" {
		t.Errorf("defaultTemplateTag = %q", got.Status.DefaultTemplateTag)
	}
	for _, name := range []string{"studio-sandbox-prod-android", "studio-sandbox-prod-android-medium"} {
		for _, u := range []*unstructured.Unstructured{newObject(TemplateGVK), newObject(PoolGVK)} {
			if err := c.Get(context.Background(), client.ObjectKey{Namespace: ns, Name: name}, u); err != nil {
				t.Fatalf("%s %s: %v", u.GetKind(), name, err)
			}
			// Deleting the variant garbage-collects exactly what it controls.
			if !metav1.IsControlledBy(u, got) {
				t.Errorf("%s %s not controlled by the variant", u.GetKind(), name)
			}
		}
	}
	pool := newObject(PoolGVK)
	_ = c.Get(context.Background(), client.ObjectKey{Namespace: ns, Name: "studio-sandbox-prod-android"}, pool)
	if n, _, _ := unstructured.NestedInt64(pool.Object, "spec", "replicas"); n != 2 {
		t.Errorf("pool replicas = %d, want 2", n)
	}
	medium := newObject(PoolGVK)
	_ = c.Get(context.Background(), client.ObjectKey{Namespace: ns, Name: "studio-sandbox-prod-android-medium"}, medium)
	if n, found, _ := unstructured.NestedInt64(medium.Object, "spec", "replicas"); !found || n != 0 {
		t.Errorf("size-0 pool must still be rendered; replicas = %d found=%v", n, found)
	}
}

func TestMissingTagKeepsThePreviousRender(t *testing.T) {
	v := androidVariant(t)
	images := registry{"ghcr.io/decocms/studio/studio-sandbox-android:1.0.0": true}
	r, c := newReconciler(t, images.exists, v)
	reconcileVariant(t, r, v)

	var live v1alpha1.SandboxVariant
	_ = c.Get(context.Background(), client.ObjectKeyFromObject(v), &live)
	live.Spec.Image.Tag = "9.9.9"
	live.Generation++
	if err := c.Update(context.Background(), &live); err != nil {
		t.Fatal(err)
	}
	_, got := reconcileVariant(t, r, &live)

	if condition(got, v1alpha1.ConditionImageAvailable) != metav1.ConditionFalse ||
		condition(got, v1alpha1.ConditionRendered) != metav1.ConditionFalse {
		t.Errorf("conditions %+v", got.Status.Conditions)
	}
	// Still usable: the old templates stay, so Ready holds.
	if condition(got, v1alpha1.ConditionReady) != metav1.ConditionTrue {
		t.Errorf("Ready = %q; the previous render is still there", condition(got, v1alpha1.ConditionReady))
	}
	if img := sandboxImageOf(t, c, "studio-sandbox-prod-android"); img != "ghcr.io/decocms/studio/studio-sandbox-android:1.0.0" {
		t.Errorf("template image = %s, want the previous tag", img)
	}
}

func TestRegistryErrorIsUnknownAndRetries(t *testing.T) {
	v := androidVariant(t)
	r, c := newReconciler(t, func(context.Context, string, authn.Keychain) (bool, error) {
		return false, errors.New("registry down")
	}, v)
	res, got := reconcileVariant(t, r, v)
	if condition(got, v1alpha1.ConditionImageAvailable) != metav1.ConditionUnknown {
		t.Errorf("ImageAvailable = %q; an outage is not a missing image", condition(got, v1alpha1.ConditionImageAvailable))
	}
	if res.RequeueAfter == 0 {
		t.Error("no retry scheduled")
	}
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: ns, Name: "studio-sandbox-prod-android"}, newObject(TemplateGVK)); err == nil {
		t.Error("rendered without an image check")
	}
}

func TestBaseTemplateChangeReRenders(t *testing.T) {
	v := androidVariant(t)
	r, c := newReconciler(t, registry{"ghcr.io/decocms/studio/studio-sandbox-android:1.0.0": true}.exists, v)
	reconcileVariant(t, r, v)

	base := template(t, c, "studio-sandbox-prod")
	_ = unstructured.SetNestedField(base.Object, int64(120), "spec", "podTemplate", "spec", "terminationGracePeriodSeconds")
	if err := c.Update(context.Background(), base); err != nil {
		t.Fatal(err)
	}
	reqs := r.variantsOfBase(context.Background(), base)
	if len(reqs) != 1 || reqs[0].Name != v.Name {
		t.Fatalf("base change enqueued %v", reqs)
	}
	medium := template(t, c, "studio-sandbox-prod-medium")
	if reqs := r.variantsOfBase(context.Background(), medium); len(reqs) != 1 {
		t.Fatalf("medium base change enqueued %v", reqs)
	}
	reconcileVariant(t, r, v)
	got, _, _ := unstructured.NestedInt64(template(t, c, "studio-sandbox-prod-android").Object, "spec", "podTemplate", "spec", "terminationGracePeriodSeconds")
	if got != 120 {
		t.Errorf("variant grace = %d, want the base's new 120", got)
	}
}

func TestMissingBaseTemplate(t *testing.T) {
	v := androidVariant(t)
	v.Name, v.Spec.BaseTemplate = "studio-sandbox-staging-android", "studio-sandbox-staging"
	r, _ := newReconciler(t, registry{}.exists, v)
	_, got := reconcileVariant(t, r, v)
	c := meta.FindStatusCondition(got.Status.Conditions, v1alpha1.ConditionRendered)
	if c == nil || c.Reason != "BaseTemplateMissing" {
		t.Errorf("Rendered = %+v", c)
	}
}

// chartOwned is a template as chart N leaves it: Helm's labels and, with
// keep, Helm's resource policy.
func chartOwned(t *testing.T, name string, keep bool) *unstructured.Unstructured {
	u := chartTemplates(t)[name].DeepCopy()
	u.SetNamespace(ns)
	labels := u.GetLabels()
	labels["app.kubernetes.io/instance"] = "sandbox-env-prod"
	u.SetLabels(labels)
	annotations := map[string]string{"meta.helm.sh/release-name": "sandbox-env-prod", "argocd.argoproj.io/sync-options": "Prune=false"}
	if keep {
		annotations[helmKeepPolicy] = "keep"
	}
	u.SetAnnotations(annotations)
	return u
}

func TestAdoptsKeptChartTemplates(t *testing.T) {
	v := androidVariant(t)
	r, c := newReconciler(t, registry{"ghcr.io/decocms/studio/studio-sandbox-android:1.0.0": true}.exists, v,
		chartOwned(t, "studio-sandbox-prod-android", true),
		chartOwned(t, "studio-sandbox-prod-android-medium", true))
	_, got := reconcileVariant(t, r, v)
	if condition(got, v1alpha1.ConditionRendered) != metav1.ConditionTrue {
		t.Fatalf("conditions %+v", got.Status.Conditions)
	}
	u := template(t, c, "studio-sandbox-prod-android")
	if !metav1.IsControlledBy(u, got) {
		t.Error("not adopted")
	}
	if u.GetLabels()["app.kubernetes.io/instance"] != "" || u.GetLabels()[LabelManagedBy] != ManagedBy {
		t.Errorf("Argo/Helm labels survived adoption: %v", u.GetLabels())
	}
	for k := range u.GetAnnotations() {
		if k == helmKeepPolicy || k == "meta.helm.sh/release-name" || k == "argocd.argoproj.io/sync-options" {
			t.Errorf("annotation %s survived adoption", k)
		}
	}
}

func TestLeavesAnObjectItDoesNotOwn(t *testing.T) {
	v := androidVariant(t)
	stillHelm := chartOwned(t, "studio-sandbox-prod-android", false)
	other := chartOwned(t, "studio-sandbox-prod-android-medium", true)
	other.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "v1", Kind: "ConfigMap", Name: "someone", UID: "other", Controller: ptr(true)}})

	for name, obj := range map[string]*unstructured.Unstructured{"helm without keep": stillHelm, "another controller": other} {
		t.Run(name, func(t *testing.T) {
			r, c := newReconciler(t, registry{"ghcr.io/decocms/studio/studio-sandbox-android:1.0.0": true}.exists, v.DeepCopy(), obj)
			_, got := reconcileVariant(t, r, v)
			cond := meta.FindStatusCondition(got.Status.Conditions, v1alpha1.ConditionRendered)
			if cond == nil || cond.Reason != "Conflict" {
				t.Fatalf("Rendered = %+v", cond)
			}
			live := template(t, c, obj.GetName())
			if metav1.IsControlledBy(live, got) || live.GetLabels()["app.kubernetes.io/instance"] == "" {
				t.Error("touched an object it does not own")
			}
		})
	}
}

func TestPullSecretsReachTheRegistryCheck(t *testing.T) {
	v := androidVariant(t)
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "ghcr"},
		Type:       corev1.SecretTypeDockerConfigJson,
		Data:       map[string][]byte{corev1.DockerConfigJsonKey: []byte(`{"auths":{"ghcr.io":{"username":"u","password":"synthetic"}}}`)},
	}
	var seen authn.Authenticator
	r, c := newReconciler(t, func(_ context.Context, ref string, kc authn.Keychain) (bool, error) {
		parsed, err := name.ParseReference(ref)
		if err != nil {
			return false, err
		}
		seen, _ = kc.Resolve(parsed.Context())
		return true, nil
	}, v, secret)
	base := template(t, c, "studio-sandbox-prod")
	_ = unstructured.SetNestedSlice(base.Object, []any{map[string]any{"name": "ghcr"}}, "spec", "podTemplate", "spec", "imagePullSecrets")
	_ = c.Update(context.Background(), base)

	reconcileVariant(t, r, v)
	cfg, err := seen.Authorization()
	if err != nil || cfg.Username != "u" {
		t.Errorf("registry check ran with %+v, %v", cfg, err)
	}
}

func ptr[T any](v T) *T { return &v }
