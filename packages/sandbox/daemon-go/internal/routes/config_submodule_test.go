package routes

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

const submodulePatch = `{"git":{"repository":{"cloneUrl":"https://github.com/acme/site.git",` +
	`"submoduleCredentials":[{"host":"github.com","token":"ghp_supersecret"}]}}}`

func storeWithSubmoduleCreds(t *testing.T) *config.Store {
	t.Helper()
	store := config.NewStore()
	var wire map[string]json.RawMessage
	if err := json.Unmarshal([]byte(submodulePatch), &wire); err != nil {
		t.Fatal(err)
	}
	patch, err := config.ParsePatch(wire)
	if err != nil {
		t.Fatal(err)
	}
	if res := store.Apply(patch); !res.Applied {
		t.Fatalf("apply rejected: %s %s", res.Reason, res.Detail)
	}
	return store
}

// The /_sandbox/config responses are proxied to the browser, so a leaked token
// would make any referenceable org secret readable.
func TestConfigResponsesRedactSubmoduleTokens(t *testing.T) {
	t.Run("GET never echoes the token", func(t *testing.T) {
		store := storeWithSubmoduleCreds(t)
		rec := httptest.NewRecorder()
		ConfigRead(ConfigDeps{
			Store:    store,
			GetReady: func() bool { return true },
		})(rec, httptest.NewRequest("GET", "/_sandbox/config", nil))

		if rec.Code != 200 {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		body := rec.Body.String()
		// Redaction must be surgical: a handler that 500s or returns an empty
		// config would satisfy every `not.Contains` below for the wrong reason.
		if !strings.Contains(body, "https://github.com/acme/site.git") {
			t.Fatalf("GET dropped the cloneUrl, so the redaction assertions prove nothing: %s", body)
		}
		if strings.Contains(body, "ghp_supersecret") {
			t.Fatalf("GET leaked the submodule token: %s", body)
		}
		if strings.Contains(body, "submoduleCredentials") {
			t.Fatalf("GET echoed the credentials field: %s", body)
		}
		// Redaction must be a copy: the clone step reads the live store.
		if got := store.Read().SubmoduleCredentials(); len(got) != 1 || got[0].Token != "ghp_supersecret" {
			t.Fatalf("serving the response mutated the store: %v", got)
		}
	})

	t.Run("PUT echo never returns the token it just accepted", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("PUT", "/_sandbox/config", strings.NewReader(submodulePatch))
		store := config.NewStore()
		ConfigUpdate(ConfigDeps{Store: store})(rec, req)

		if rec.Code != 200 {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		body := rec.Body.String()
		if !strings.Contains(body, "https://github.com/acme/site.git") {
			t.Fatalf("PUT echo dropped the cloneUrl, so the redaction assertions prove nothing: %s", body)
		}
		if strings.Contains(body, "ghp_supersecret") {
			t.Fatalf("PUT echo leaked the submodule token: %s", body)
		}
		// …but the daemon kept it, or the clone step has nothing to authenticate with.
		got := store.Read().SubmoduleCredentials()
		if len(got) != 1 || got[0].Host != "github.com" || got[0].Token != "ghp_supersecret" {
			t.Fatalf("store did not keep the credentials: %v", got)
		}
	})
}
