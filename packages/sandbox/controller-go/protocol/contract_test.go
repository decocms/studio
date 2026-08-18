// Contract test against the TypeScript mirror: a field renamed on one side
// alone compiles and passes both suites, breaking only against a real
// controller. Compares name sets, not types — enough to catch a rename.
package protocol

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Two files: protocol.ts holds the envelopes, types.ts the payload types they
// carry. Go was transcribed from both, so scanning one leaves half unguarded.
var tsPaths = []string{
	"../../server/provider/remote/protocol.ts",
	"../../server/provider/types.ts",
}

// mirrored is every Go type with a TypeScript counterpart.
var mirrored = map[string]any{
	"SandboxID":           SandboxID{},
	"Workload":            Workload{},
	"SubmoduleCredential": SubmoduleCredential{},
	"Repo":                Repo{},
	"Tenant":              Tenant{},
	"EnsureOptions":       EnsureOptions{},
	"EnsureRequest":       EnsureRequest{},
	"Daemon":              Daemon{},
	"EnsureResponse":      EnsureResponse{},
	"StatusResponse":      StatusResponse{},
	"PodTermination":      PodTermination{},
	"LifetimeRequest":     LifetimeRequest{},
	"Capacity":            Capacity{},
	"RuntimeInfo":         RuntimeInfo{},
	"RuntimesResponse":    RuntimesResponse{},
	"CapacityResponse":    CapacityResponse{},
	"AdoptResponse":       AdoptResponse{},
	"CloneURLRequest":     CloneURLRequest{},
	"CloneURLResponse":    CloneURLResponse{},
}

func jsonNames(v any) []string {
	t := reflect.TypeOf(v)
	var out []string
	for i := range t.NumField() {
		tag := t.Field(i).Tag.Get("json")
		if tag == "" || tag == "-" {
			continue
		}
		out = append(out, strings.Split(tag, ",")[0])
	}
	sort.Strings(out)
	return out
}

// tsIdentifiers is every property-position identifier in the TS mirror.
func tsIdentifiers(t *testing.T) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for _, path := range tsPaths {
		blob, err := os.ReadFile(filepath.FromSlash(path))
		if err != nil {
			t.Fatalf("cannot read the TypeScript mirror at %s: %v", path, err)
		}
		// Strip comments so prose naming an old field cannot mask a rename.
		src := regexp.MustCompile(`(?s)/\*.*?\*/`).ReplaceAllString(string(blob), "")
		src = regexp.MustCompile(`(?m)//.*$`).ReplaceAllString(src, "")
		// `foo:`/`foo?:` at a line start, or after `{`/`;`/`,` for inline unions.
		for _, m := range regexp.MustCompile(`(?m)(?:^|[{;,])\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:`).FindAllStringSubmatch(src, -1) {
			out[m[1]] = true
		}
	}
	return out
}

func TestEveryGoFieldExistsInTheTypeScriptMirror(t *testing.T) {
	ts := tsIdentifiers(t)
	for name, v := range mirrored {
		for _, field := range jsonNames(v) {
			if !ts[field] {
				t.Errorf("%s.%s has no counterpart in the TypeScript mirror — the wire contract has drifted", name, field)
			}
		}
	}
}

func TestEveryTypeScriptFieldExistsInGo(t *testing.T) {
	goFields := map[string]bool{}
	for _, v := range mirrored {
		for _, field := range jsonNames(v) {
			goFields[field] = true
		}
	}
	// types.ts is scanned whole, so it also yields shapes that never cross the wire.
	exempt := map[string]bool{
		// ProxyRequestInit — studio → daemon, never studio → controller.
		"method": true, "headers": true, "body": true, "signal": true,
		"path": true, "init": true, "request": true,
		// ClaimPhase discriminants, emitted as JSON by the runtime package.
		"kind": true, "reason": true, "message": true,
	}

	for name := range tsIdentifiers(t) {
		if !goFields[name] && !exempt[name] {
			t.Errorf("the TypeScript mirror declares %q with no Go counterpart — the wire contract has drifted", name)
		}
	}
}
