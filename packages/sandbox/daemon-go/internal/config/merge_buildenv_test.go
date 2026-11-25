package config

import (
	"encoding/json"
	"reflect"
	"testing"
)

func parsePatch(t *testing.T, body string) *Patch {
	t.Helper()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		t.Fatal(err)
	}
	patch, err := ParsePatch(raw)
	if err != nil {
		t.Fatal(err)
	}
	return patch
}

func TestMergeBuildEnv(t *testing.T) {
	current := &TenantConfig{
		Env:      map[string]string{"API_URL": "https://example.test"},
		BuildEnv: map[string]string{"NPM_TOKEN": "old", "GONE": "x"},
	}

	t.Run("a patch without it keeps the current set", func(t *testing.T) {
		got := DeepMerge(current, parsePatch(t, `{"env":{"API_URL":"https://other.test"}}`))
		if !reflect.DeepEqual(got.BuildEnv, current.BuildEnv) {
			t.Fatalf("buildEnv = %v, want %v", got.BuildEnv, current.BuildEnv)
		}
	})

	t.Run("a patch with it replaces the whole set", func(t *testing.T) {
		got := DeepMerge(current, parsePatch(t, `{"buildEnv":{"NPM_TOKEN":"new"}}`))
		want := map[string]string{"NPM_TOKEN": "new"}
		if !reflect.DeepEqual(got.BuildEnv, want) {
			t.Fatalf("buildEnv = %v, want %v", got.BuildEnv, want)
		}
		if !reflect.DeepEqual(got.Env, current.Env) {
			t.Fatalf("env = %v, want it untouched", got.Env)
		}
	})

	t.Run("an explicit empty set clears it", func(t *testing.T) {
		got := DeepMerge(current, parsePatch(t, `{"buildEnv":{}}`))
		if got.BuildEnv != nil {
			t.Fatalf("buildEnv = %v, want nil", got.BuildEnv)
		}
	})

	t.Run("is validated like env", func(t *testing.T) {
		merged := DeepMerge(nil, parsePatch(t, `{"buildEnv":{"not a key":"x"}}`))
		if reason := Validate(merged); reason == "" {
			t.Fatal("accepted an invalid build env key")
		}
	})

	t.Run("changing it alone is not a transition", func(t *testing.T) {
		before := &TenantConfig{Env: map[string]string{"A": "1"}}
		after := DeepMerge(before, parsePatch(t, `{"buildEnv":{"NPM_TOKEN":"new"}}`))
		if kind := Classify(before, after).Kind; kind != KindNoOp {
			t.Fatalf("kind = %v, want no-op: a build var must not restart the dev server", kind)
		}
	})
}
