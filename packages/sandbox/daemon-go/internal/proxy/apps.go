package proxy

import (
	"html"
	"net"
	"net/http"
	"regexp"
	"strings"
)

// AppSlugHeader names an extra app when the host cannot, e.g. behind a proxy
// that rewrites Host.
const AppSlugHeader = "X-Sandbox-App"

// AppSlugFromRequest is the extra app a preview request is for, "" for the
// main app. Hosted previews name it after the handle (`<handle>--<slug>.<base>`),
// loopback ones as the first label (`<slug>.localhost`). A slug that names no
// configured app falls back to the main app, so a handle that happens to
// contain `--` still reaches it.
func AppSlugFromRequest(r *http.Request) string {
	if slug := strings.ToLower(strings.TrimSpace(r.Header.Get(AppSlugHeader))); slug != "" {
		return slug
	}
	host := strings.ToLower(r.Host)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	label, _, hasDomain := strings.Cut(host, ".")
	if !hasDomain {
		return ""
	}
	if i := strings.LastIndex(label, "--"); i >= 0 {
		return label[i+2:]
	}
	if strings.HasSuffix(host, ".localhost") {
		return label
	}
	return ""
}

// ServeStarting is the self-refreshing page shown while a dev server boots.
func ServeStarting(w http.ResponseWriter) {
	htmlResponse(w, 503, StartingHTML, map[string]string{"Retry-After": "1"})
}

var ansiEscapes = regexp.MustCompile(`\x1b\[[0-9;?]*[a-zA-Z]`)

const appStoppedLogLines = 40

// ServeAppStopped explains why an extra app is not serving, with the end of its log.
func ServeAppStopped(w http.ResponseWriter, path, reason, log string) {
	lines := strings.Split(strings.TrimRight(ansiEscapes.ReplaceAllString(log, ""), "\r\n"), "\n")
	if len(lines) > appStoppedLogLines {
		lines = lines[len(lines)-appStoppedLogLines:]
	}
	tail := strings.TrimSpace(strings.Join(lines, "\n"))
	body := `<!DOCTYPE html><html><head><meta charset="utf-8"><title>App stopped</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:32px;background:#fafafa;color:#555}h3{margin:0 0 8px}p{margin:0 0 16px;font-size:14px;color:#999}pre{font-size:12px;background:#fff;border:1px solid #eee;border-radius:6px;padding:12px;overflow:auto;white-space:pre-wrap;color:#333}</style></head><body><h3>` +
		html.EscapeString(path) + ` is not running</h3><p>` + html.EscapeString(reason) + `. Reload the preview to start it again.</p>`
	if tail != "" {
		body += `<pre>` + html.EscapeString(tail) + `</pre>`
	}
	body += `</body></html>`
	htmlResponse(w, 503, body, nil)
}
