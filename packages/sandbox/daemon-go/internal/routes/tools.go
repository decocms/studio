package routes

import (
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/toolscatalog"
)

type ToolsDeps struct {
	AppRoot string
	RepoDir string
}

type toolsSyncBody struct {
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt *float64          `json:"expiresAt"`
}

// ToolsSync handles POST /_sandbox/tools/sync — body `{ url, headers,
// expiresAt? }` (the run's Virtual MCP endpoint). Writes the endpoint file,
// then lists the endpoint's tools and writes a JSON Schema catalog under
// `<repo>/.deco/tools/`. Idempotent; overwrites and prunes stale files.
// Returns `{ count, tools }`. 502 when the endpoint is unreachable/errors (the
// endpoint file is still written), 500 when the local write fails.
func ToolsSync(deps ToolsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body toolsSyncBody
		raw := json.NewDecoder(r.Body)
		if err := raw.Decode(&body); err != nil {
			httpx.Error(w, 400, "invalid JSON body")
			return
		}
		if body.URL == "" || !isAbsoluteURL(body.URL) || body.Headers == nil {
			httpx.Error(w, 400,
				"body must be { url: string (valid URL), headers: Record<string,string> }")
			return
		}

		ep := toolscatalog.Endpoint{URL: body.URL, Headers: body.Headers}
		if body.ExpiresAt != nil {
			ep.ExpiresAt = int64(*body.ExpiresAt)
		}
		opts := toolscatalog.Opts{AppRoot: deps.AppRoot, RepoDir: deps.RepoDir}

		if _, err := toolscatalog.WriteEndpointFile(ep, opts); err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}

		tools, err := toolscatalog.FetchCatalog(r.Context(), ep)
		if err != nil {
			httpx.Error(w, 502, err.Error())
			return
		}

		count, names, err := toolscatalog.WriteCatalog(tools, opts)
		if err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		httpx.JSON(w, 200, map[string]any{"count": count, "tools": names})
	}
}

// isAbsoluteURL mirrors `URL.canParse` — a bare path or an empty scheme is not
// a usable MCP endpoint (the decopilot in-process sentinel used to send one).
func isAbsoluteURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme != "" && u.Host != ""
}
