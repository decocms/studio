package dispatch

import (
	"encoding/json"
	"testing"
)

func memoryOf(t *testing.T, input json.RawMessage) (map[string]any, bool) {
	t.Helper()
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(input, &obj); err != nil {
		t.Fatalf("input is not an object: %v", err)
	}
	raw, ok := obj["memory"]
	if !ok {
		return nil, false
	}
	var memory map[string]any
	if err := json.Unmarshal(raw, &memory); err != nil {
		t.Fatalf("memory is not an object: %s", raw)
	}
	return memory, true
}

func onMount(directory string) string { return "/app/org/home/" + directory }

func TestResolveMemoryLeavesAnInputWithoutTheFieldAlone(t *testing.T) {
	input := json.RawMessage(`{"threadId":"t1","mode":"default"}`)
	called := false
	out := resolveMemory(input, func(string) string { called = true; return "/x" })
	if string(out) != string(input) {
		t.Fatalf("input changed: %s", out)
	}
	if called {
		t.Fatal("resolved a folder nobody asked for")
	}
}

func TestResolveMemoryWritesTheFolderOnTheMount(t *testing.T) {
	input := json.RawMessage(`{"threadId":"t1","memory":{"enabled":true,"directory":"users/user_1"}}`)
	out := resolveMemory(input, onMount)
	memory, _ := memoryOf(t, out)
	if memory["enabled"] != true || memory["directory"] != "/app/org/home/users/user_1" {
		t.Fatalf("memory = %v", memory)
	}
	var obj map[string]json.RawMessage
	json.Unmarshal(out, &obj)
	if string(obj["threadId"]) != `"t1"` {
		t.Fatalf("the rest of the input was lost: %s", out)
	}
}

func TestResolveMemoryKeepsEachRunsOwnFolder(t *testing.T) {
	one, _ := memoryOf(t, resolveMemory(
		json.RawMessage(`{"memory":{"enabled":true,"directory":"users/user_1"}}`), onMount))
	other, _ := memoryOf(t, resolveMemory(
		json.RawMessage(`{"memory":{"enabled":true,"directory":"users/user_2"}}`), onMount))
	if one["directory"] == other["directory"] {
		t.Fatalf("two runs resolved to %v", one["directory"])
	}
}

// Off, never the relative path: the harness would fall back to the pod's disk.
func TestResolveMemoryTurnsOffWhatItCannotResolve(t *testing.T) {
	unresolved := func(string) string { return "" }
	cases := map[string]struct {
		input   string
		resolve func(string) string
	}{
		"folder unusable":  {`{"memory":{"enabled":true,"directory":"users/user_1"}}`, unresolved},
		"no resolver":      {`{"memory":{"enabled":true,"directory":"users/user_1"}}`, nil},
		"already off":      {`{"memory":{"enabled":false}}`, onMount},
		"off with a path":  {`{"memory":{"enabled":false,"directory":"users/user_1"}}`, onMount},
		"null":             {`{"memory":null}`, onMount},
		"not an object":    {`{"memory":"users/user_1"}`, onMount},
		"enabled a string": {`{"memory":{"enabled":"true","directory":"users/user_1"}}`, onMount},
	}
	for name, c := range cases {
		memory, ok := memoryOf(t, resolveMemory(json.RawMessage(c.input), c.resolve))
		if !ok || memory["enabled"] != false {
			t.Errorf("%s: memory = %v", name, memory)
		}
		if _, has := memory["directory"]; has {
			t.Errorf("%s: an off memory kept a directory: %v", name, memory)
		}
	}
}
