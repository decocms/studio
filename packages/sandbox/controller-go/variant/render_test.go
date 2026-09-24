package variant

import (
	"bytes"
	"os"
	"os/exec"
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	yamlutil "k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/yaml"

	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
)

// testdata/chart-templates.yaml is the sandbox-env chart's own render, so this
// test is the adoption contract: a template the controller adopts from the
// chart must come out byte-for-byte the same spec, or the first reconcile
// rewrites every variant pod's template. Regenerate after a chart change:
//
//	helm template t deploy/helm/sandbox-env --set envName=prod --set image.tag=1.0.0 \
//	  -f packages/sandbox/controller-go/variant/testdata/android-values.yaml
//
// keeping only the SandboxTemplates.
func chartTemplates(t *testing.T) map[string]*unstructured.Unstructured {
	t.Helper()
	f, err := os.Open("testdata/chart-templates.yaml")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	out := map[string]*unstructured.Unstructured{}
	dec := yamlutil.NewYAMLOrJSONDecoder(f, 4096)
	for {
		u := &unstructured.Unstructured{}
		if err := dec.Decode(&u.Object); err != nil {
			break
		}
		if u.Object != nil {
			out[u.GetName()] = u
		}
	}
	return out
}

// The fixture's specs must be the chart's current render (labels carry the
// chart version, so they are not compared), or the golden test above
// proves parity with a chart that no longer exists. CI installs helm.
func TestFixtureIsTheChartsRender(t *testing.T) {
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm not installed")
	}
	out, err := exec.Command("helm", "template", "t", "../../../../deploy/helm/sandbox-env",
		"--set", "envName=prod", "--set", "image.tag=1.0.0", "-f", "testdata/android-values.yaml").Output()
	if err != nil {
		t.Fatal(err)
	}
	live := map[string]any{}
	dec := yamlutil.NewYAMLOrJSONDecoder(bytes.NewReader(out), 4096)
	for {
		u := &unstructured.Unstructured{}
		if err := dec.Decode(&u.Object); err != nil {
			break
		}
		if u.GetKind() == "SandboxTemplate" {
			spec, _, _ := unstructured.NestedMap(u.Object, "spec")
			live[u.GetName()] = normalize(t, spec)
		}
	}
	fixture := map[string]any{}
	for name, u := range chartTemplates(t) {
		spec, _, _ := unstructured.NestedMap(u.Object, "spec")
		fixture[name] = normalize(t, spec)
	}
	if !reflect.DeepEqual(live, fixture) {
		t.Fatal("testdata/chart-templates.yaml is stale; regenerate it (see chartTemplates)")
	}
}

// androidVariant is testdata/android-values.yaml as a SandboxVariant, the way
// chart N+1 will write it.
func androidVariant(t *testing.T) *v1alpha1.SandboxVariant {
	t.Helper()
	raw, err := os.ReadFile("testdata/android-values.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var values struct {
		ImageVariants map[string]struct {
			Repository   string                       `json:"repository"`
			NodeSelector map[string]string            `json:"nodeSelector"`
			Tolerations  []corev1.Toleration          `json:"tolerations"`
			Resources    corev1.ResourceRequirements  `json:"resources"`
			VolumeSizes  map[string]resource.Quantity `json:"volumeSizes"`
		} `json:"imageVariants"`
	}
	if err := yaml.Unmarshal(raw, &values); err != nil {
		t.Fatal(err)
	}
	a := values.ImageVariants["android"]
	return &v1alpha1.SandboxVariant{
		ObjectMeta: metav1.ObjectMeta{Name: "studio-sandbox-prod-android", Namespace: "agent-sandbox-system"},
		Spec: v1alpha1.SandboxVariantSpec{
			BaseTemplate: "studio-sandbox-prod",
			Image:        v1alpha1.Image{Repository: a.Repository, Tag: "1.0.0"},
			BaseTag:      "1.0.0",
			NodeSelector: a.NodeSelector,
			Tolerations:  a.Tolerations,
			Resources:    a.Resources,
			VolumeSizes:  a.VolumeSizes,
		},
	}
}

func TestRenderMatchesTheChart(t *testing.T) {
	chart := chartTemplates(t)
	v := androidVariant(t)
	for base, want := range map[string]string{
		"studio-sandbox-prod":        "studio-sandbox-prod-android",
		"studio-sandbox-prod-medium": "studio-sandbox-prod-android-medium",
	} {
		got, err := RenderTemplate(chart[base], v, want)
		if err != nil {
			t.Fatal(err)
		}
		wantSpec, _, _ := unstructured.NestedMap(chart[want].Object, "spec")
		gotSpec, _, _ := unstructured.NestedMap(got.Object, "spec")
		if !reflect.DeepEqual(normalize(t, wantSpec), normalize(t, gotSpec)) {
			w, _ := yaml.Marshal(wantSpec)
			g, _ := yaml.Marshal(gotSpec)
			t.Errorf("%s: render differs from the chart\n--- chart\n%s\n--- controller\n%s", want, w, g)
		}
		if got.GetName() != want {
			t.Errorf("name = %q, want %q", got.GetName(), want)
		}
	}
}

// normalize round-trips through YAML so quantities compare by their string
// form ("8Gi" in both), which is what the API server stores.
func normalize(t *testing.T, m map[string]any) any {
	t.Helper()
	b, err := yaml.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := yaml.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRenderLabels(t *testing.T) {
	chart := chartTemplates(t)
	got, err := RenderTemplate(chart["studio-sandbox-prod"], androidVariant(t), "studio-sandbox-prod-android")
	if err != nil {
		t.Fatal(err)
	}
	labels := got.GetLabels()
	for k := range foreignLabels {
		if k != LabelManagedBy && labels[k] != "" {
			t.Errorf("label %s copied from the base; Argo CD would claim the object", k)
		}
	}
	if labels[LabelManagedBy] != ManagedBy || labels[LabelVariant] != "android" {
		t.Errorf("labels = %v", labels)
	}
	if labels["studio.decocms.com/env"] != "prod" {
		t.Errorf("env label not carried over: %v", labels)
	}
}

func TestRenderRequiresASandboxContainer(t *testing.T) {
	base := chartTemplates(t)["studio-sandbox-prod"].DeepCopy()
	_ = unstructured.SetNestedSlice(base.Object, []any{}, "spec", "podTemplate", "spec", "containers")
	if _, err := RenderTemplate(base, androidVariant(t), "x"); err == nil {
		t.Fatal("rendered a template with no sandbox container")
	}
}

func TestImageTag(t *testing.T) {
	for ref, want := range map[string]string{
		"ghcr.io/a/b:1.2.3":     "1.2.3",
		"localhost:5000/a/b":    "",
		"localhost:5000/a/b:v1": "v1",
		"ghcr.io/a/b":           "",
	} {
		if got := ImageTag(ref); got != want {
			t.Errorf("ImageTag(%q) = %q, want %q", ref, got, want)
		}
	}
}
