package variant

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apiextensionsinternal "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	structuralschema "k8s.io/apiextensions-apiserver/pkg/apiserver/schema"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/schema/cel"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/validation"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/validation/field"
	yamlutil "k8s.io/apimachinery/pkg/util/yaml"
	celconfig "k8s.io/apiserver/pkg/apis/cel"
	"sigs.k8s.io/yaml"

	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
)

// testdata/chart-templates.yaml is sandbox-env 0.21.0's render, the last
// chart version that rendered variant templates, so this test is the adoption
// contract: a template the controller adopts from that chart must come out
// byte-for-byte the same spec, or the first reconcile rewrites every variant
// pod's template. It was rendered with
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

// The chart now writes testdata/android-values.yaml as a SandboxVariant. It
// must be the one androidVariant builds, so the adoption contract above is
// the one the chart's variant gets, and it must pass the CRD's schema and CEL
// rules, or `helm upgrade` fails on apply. CI installs helm.
func TestChartRendersTheVariant(t *testing.T) {
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm not installed")
	}
	out, err := exec.Command("helm", "template", "t", "../../../../deploy/helm/sandbox-env",
		"--set", "envName=prod", "--set", "image.tag=1.0.0", "-f", "testdata/android-values.yaml").Output()
	if err != nil {
		t.Fatal(err)
	}
	var variants []map[string]any
	dec := yamlutil.NewYAMLOrJSONDecoder(bytes.NewReader(out), 4096)
	for {
		u := &unstructured.Unstructured{}
		if err := dec.Decode(&u.Object); err != nil {
			break
		}
		switch u.GetKind() {
		case "SandboxVariant":
			variants = append(variants, u.Object)
		case "SandboxTemplate", "SandboxWarmPool":
			if u.GetLabels()[LabelVariant] != "" || strings.Contains(u.GetName(), "-android") {
				t.Errorf("chart still renders %s %s; the controller owns it", u.GetKind(), u.GetName())
			}
		}
	}
	if len(variants) != 1 {
		t.Fatalf("rendered %d SandboxVariants, want 1", len(variants))
	}

	schema, validator := crdValidator(t)
	if errs := validation.ValidateCustomResource(field.NewPath("root"), variants[0], schema); len(errs) > 0 {
		t.Errorf("schema: %v", errs)
	}
	if errs, _ := validator.Validate(context.Background(), field.NewPath("root"), crdStructural(t), variants[0], nil, celconfig.RuntimeCELCostBudget); len(errs) > 0 {
		t.Errorf("CEL: %v", errs)
	}

	raw, err := yaml.Marshal(variants[0])
	if err != nil {
		t.Fatal(err)
	}
	var got v1alpha1.SandboxVariant
	if err := yaml.UnmarshalStrict(raw, &got); err != nil {
		t.Fatalf("chart renders a field the API does not have: %v", err)
	}
	want := androidVariant(t)
	if got.Name != want.Name || got.Namespace != want.Namespace {
		t.Errorf("rendered %s/%s, want %s/%s", got.Namespace, got.Name, want.Namespace, want.Name)
	}
	g, _ := yaml.Marshal(got.Spec)
	w, _ := yaml.Marshal(want.Spec)
	if !bytes.Equal(g, w) {
		t.Errorf("chart's SandboxVariant differs\n--- chart\n%s\n--- androidVariant\n%s", g, w)
	}
}

func crdSchema(t *testing.T) *apiextensionsinternal.JSONSchemaProps {
	t.Helper()
	raw, err := os.ReadFile("../../../../deploy/helm/sandbox-controller/crds/sandbox.deco.cx_sandboxvariants.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var crd apiextensionsv1.CustomResourceDefinition
	if err := yaml.Unmarshal(raw, &crd); err != nil {
		t.Fatal(err)
	}
	var internal apiextensionsinternal.JSONSchemaProps
	if err := apiextensionsv1.Convert_v1_JSONSchemaProps_To_apiextensions_JSONSchemaProps(crd.Spec.Versions[0].Schema.OpenAPIV3Schema, &internal, nil); err != nil {
		t.Fatal(err)
	}
	return &internal
}

func crdStructural(t *testing.T) *structuralschema.Structural {
	t.Helper()
	s, err := structuralschema.NewStructural(crdSchema(t))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func crdValidator(t *testing.T) (validation.SchemaValidator, *cel.Validator) {
	t.Helper()
	schema, _, err := validation.NewSchemaValidator(crdSchema(t))
	if err != nil {
		t.Fatal(err)
	}
	return schema, cel.NewValidator(crdStructural(t), true, celconfig.PerCallLimit)
}

// androidVariant is testdata/android-values.yaml as a SandboxVariant, the way
// the chart writes it.
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
