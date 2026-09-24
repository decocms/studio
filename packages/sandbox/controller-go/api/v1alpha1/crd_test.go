package v1alpha1

import (
	"context"
	"os"
	"testing"

	apiextensionsinternal "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	structuralschema "k8s.io/apiextensions-apiserver/pkg/apiserver/schema"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/schema/cel"
	"k8s.io/apimachinery/pkg/util/validation/field"
	celconfig "k8s.io/apiserver/pkg/apis/cel"
	"sigs.k8s.io/yaml"
)

// The name rules live only in the CRD's CEL, which a fake client never runs.
// This evaluates the generated CRD the way the API server does.
func TestCRDRejectsBadNames(t *testing.T) {
	raw, err := os.ReadFile("../../../../../deploy/helm/sandbox-controller/crds/sandbox.deco.cx_sandboxvariants.yaml")
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
	s, err := structuralschema.NewStructural(&internal)
	if err != nil {
		t.Fatal(err)
	}
	validator := cel.NewValidator(s, true, celconfig.PerCallLimit)

	for _, tc := range []struct {
		name, base, tag string
		ok              bool
	}{
		{"studio-sandbox-prod-android", "studio-sandbox-prod", "1.0.0", true},
		{"studio-sandbox-prod-a1-b2", "studio-sandbox-prod", "1.0.0", true},
		{"android", "studio-sandbox-prod", "1.0.0", false},                   // not <base>-<v>
		{"studio-sandbox-prod-Android", "studio-sandbox-prod", "1.0.0", false}, // uppercase
		{"studio-sandbox-prod-1droid", "studio-sandbox-prod", "1.0.0", false},  // leading digit
		{"studio-sandbox-prod-medium", "studio-sandbox-prod", "1.0.0", false},  // is the base's medium template
		{"studio-sandbox-prod-x-medium", "studio-sandbox-prod", "1.0.0", false},
		{"studio-sandbox-prod-" + string(make([]byte, 33)), "studio-sandbox-prod", "1.0.0", false},
		{"studio-sandbox-prod-android", "studio-sandbox-prod", "latest", false},
	} {
		obj := map[string]any{
			"apiVersion": "sandbox.deco.cx/v1alpha1",
			"kind":       "SandboxVariant",
			"metadata":   map[string]any{"name": tc.name},
			"spec": map[string]any{
				"baseTemplate": tc.base,
				"baseTag":      "1.0.0",
				"image":        map[string]any{"repository": "ghcr.io/x/y", "tag": tc.tag},
			},
		}
		errs, _ := validator.Validate(context.Background(), field.NewPath("root"), s, obj, nil, celconfig.RuntimeCELCostBudget)
		if got := len(errs) == 0; got != tc.ok {
			t.Errorf("%s (tag %s): accepted=%v, want %v: %v", tc.name, tc.tag, got, tc.ok, errs)
		}
	}
}
