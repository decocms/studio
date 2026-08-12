package toolscatalog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// TestFetchCatalogBoundsPagination guards against a misbehaving or malicious
// Virtual MCP endpoint that never returns an empty nextCursor: without a page
// cap, FetchCatalog would loop and grow its result slice forever.
func TestFetchCatalogBoundsPagination(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
			ID     *int   `json:"id"`
			Params struct {
				Cursor string `json:"cursor"`
			} `json:"params"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")

		if req.ID == nil {
			// notification (e.g. notifications/initialized): no response body.
			w.WriteHeader(200)
			return
		}

		switch req.Method {
		case "initialize":
			json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": *req.ID, "result": map[string]any{},
			})
		case "tools/list":
			next := "0"
			if req.Params.Cursor != "" {
				n, _ := strconv.Atoi(req.Params.Cursor)
				next = strconv.Itoa(n + 1)
			}
			json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": *req.ID,
				"result": map[string]any{
					"tools":      []Tool{{Name: "t" + next}},
					"nextCursor": next, // never empty — simulates an endpoint stuck in a loop
				},
			})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	_, err := FetchCatalog(context.Background(), Endpoint{URL: srv.URL})
	if err == nil {
		t.Fatal("expected FetchCatalog to give up on unbounded pagination, got nil error")
	}
	if !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("expected a page-limit error, got: %v", err)
	}
}
