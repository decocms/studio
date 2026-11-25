package routes

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

// Build env holds resolved secrets and the /_sandbox/config responses are
// proxied to the browser.
func TestConfigResponsesRedactBuildEnv(t *testing.T) {
	bodies := map[string]string{
		"beside a repo": `{"git":{"repository":{"cloneUrl":"https://github.com/acme/site.git"}},` +
			`"buildEnv":{"NPM_TOKEN":"npm_supersecret"}}`,
		"without a repo": `{"buildEnv":{"NPM_TOKEN":"npm_supersecret"}}`,
	}
	for name, body := range bodies {
		t.Run("PUT echo "+name, func(t *testing.T) {
			store := config.NewStore()
			// A build-env-only patch is a no-op transition, which an unclaimed
			// store does not persist: claim it first, or there is nothing held
			// to redact and the assertions below pass for the wrong reason.
			ConfigUpdate(ConfigDeps{Store: store})(httptest.NewRecorder(),
				httptest.NewRequest("PUT", "/_sandbox/config", strings.NewReader(`{"env":{"CLAIMED":"1"}}`)))
			rec := httptest.NewRecorder()
			ConfigUpdate(ConfigDeps{Store: store})(rec,
				httptest.NewRequest("PUT", "/_sandbox/config", strings.NewReader(body)))
			if rec.Code != 200 {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			if out := rec.Body.String(); strings.Contains(out, "npm_supersecret") || strings.Contains(out, "buildEnv") {
				t.Fatalf("PUT echoed the build env: %s", out)
			}
			if cfg := store.Read(); cfg == nil || cfg.BuildEnv["NPM_TOKEN"] != "npm_supersecret" {
				t.Fatalf("store does not hold the build env, so redaction is untested: %+v", cfg)
			}

			rec = httptest.NewRecorder()
			ConfigRead(ConfigDeps{Store: store, GetReady: func() bool { return true }})(rec,
				httptest.NewRequest("GET", "/_sandbox/config", nil))
			if out := rec.Body.String(); strings.Contains(out, "npm_supersecret") || strings.Contains(out, "NPM_TOKEN") {
				t.Fatalf("GET leaked the build env: %s", out)
			}
		})
	}

	t.Run("redaction copies: the clone step reads the live store", func(t *testing.T) {
		store := config.NewStore()
		ConfigUpdate(ConfigDeps{Store: store})(httptest.NewRecorder(),
			httptest.NewRequest("PUT", "/_sandbox/config", strings.NewReader(bodies["beside a repo"])))
		cfg := store.Read()
		if cfg == nil || cfg.BuildEnv["NPM_TOKEN"] != "npm_supersecret" {
			t.Fatalf("store lost the build env: %+v", cfg)
		}
	})
}
