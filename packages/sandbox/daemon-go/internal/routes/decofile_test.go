package routes

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

func writeBlock(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir blocks dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".json"), []byte(body), 0o644); err != nil {
		t.Fatalf("write block %s: %v", name, err)
	}
}

func TestDecofileHandlerReturns404WhenNoBlocks(t *testing.T) {
	dir := t.TempDir()
	deps := DecofileDeps{RepoDir: dir, Store: config.NewStore()}

	req := httptest.NewRequest(http.MethodGet, "/decofile", nil)
	rec := httptest.NewRecorder()
	Decofile(deps)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestDecofileHandlerServesEtagAndRevalidates(t *testing.T) {
	dir := t.TempDir()
	writeBlock(t, filepath.Join(dir, ".deco", "blocks"), "pages-home", `{"path":"/","sections":[]}`)
	deps := DecofileDeps{RepoDir: dir, Store: config.NewStore()}

	req := httptest.NewRequest(http.MethodGet, "/decofile", nil)
	rec := httptest.NewRecorder()
	Decofile(deps)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("expected no-store cache-control, got %q", rec.Header().Get("Cache-Control"))
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("expected an ETag header")
	}

	// Matching If-None-Match revalidates to 304 with an empty body.
	req2 := httptest.NewRequest(http.MethodGet, "/decofile", nil)
	req2.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	Decofile(deps)(rec2, req2)
	if rec2.Code != http.StatusNotModified {
		t.Fatalf("expected 304, got %d", rec2.Code)
	}
	if rec2.Body.Len() != 0 {
		t.Errorf("expected an empty 304 body, got %q", rec2.Body.String())
	}

	// A stale If-None-Match still gets the full body.
	req3 := httptest.NewRequest(http.MethodGet, "/decofile", nil)
	req3.Header.Set("If-None-Match", `W/"deadbeef"`)
	rec3 := httptest.NewRecorder()
	Decofile(deps)(rec3, req3)
	if rec3.Code != http.StatusOK {
		t.Fatalf("expected 200 for a stale ETag, got %d", rec3.Code)
	}
}

func TestDecofileHandlerRespectsPackageManagerPath(t *testing.T) {
	dir := t.TempDir()
	writeBlock(t, filepath.Join(dir, "apps", "web", ".deco", "blocks"), "pages-home", `{"path":"/"}`)

	store := config.NewStore()
	store.Hydrate(&config.TenantConfig{
		Application: &config.Application{
			PackageManager: &config.PackageManagerConfig{Path: config.Str("apps/web")},
		},
	})
	deps := DecofileDeps{RepoDir: dir, Store: store}

	req := httptest.NewRequest(http.MethodGet, "/decofile", nil)
	rec := httptest.NewRecorder()
	Decofile(deps)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}
