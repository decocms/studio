package proxy

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/probe"
	"github.com/decocms/studio/sandbox-daemon/internal/telemetry"
)

type Deps struct {
	GetDevPort func() int
	Log        func(msg string)
}

type Handler struct {
	deps      Deps
	transport *http.Transport
}

func New(deps Deps) *Handler {
	return &Handler{
		deps: deps,
		transport: &http.Transport{
			DialContext:           probe.DialLoopback,
			DisableCompression:    true,
			ResponseHeaderTimeout: 60 * time.Second,
			MaxIdleConnsPerHost:   16,
		},
	}
}

func htmlResponse(w http.ResponseWriter, status int, body string, extra map[string]string) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Access-Control-Allow-Origin", "*")
	for k, v := range extra {
		h.Set(k, v)
	}
	w.WriteHeader(status)
	io.WriteString(w, body)
}

// A page navigation, as opposed to an asset/XHR fetch. Browsers ask for
// `text/html` when loading a document or an iframe and `*/*` (or `image/*`,
// …) for everything a page then pulls in — so this is what decides whether a
// human is waiting behind the request and should see a page rather than a
// proxy error.
func acceptsHTML(r *http.Request) bool {
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/html")
}

func isConnError(err error) bool {
	msg := err.Error()
	for _, pat := range []string{
		"connection refused", "connection reset", "connect: ", "no such host",
		"i/o timeout", "timeout awaiting response headers", "EOF",
	} {
		if strings.Contains(msg, pat) {
			return true
		}
	}
	return false
}

func (p *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	port := p.deps.GetDevPort()
	if port == 0 {
		htmlResponse(w, 503, NoUpstreamHTML, nil)
		return
	}
	if p.deps.Log != nil {
		p.deps.Log(fmt.Sprintf("proxy %s %s", r.Method, r.URL.Path))
	}

	outURL := "http://[::1]:" + strconv.Itoa(port) + r.URL.RequestURI()
	var body io.Reader
	if r.Method != "GET" && r.Method != "HEAD" {
		body = r.Body
	}
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, outURL, body)
	if err != nil {
		p.proxyError(w, r, port, err)
		return
	}
	outReq.Header = r.Header.Clone()
	outReq.Header.Del("Accept-Encoding")
	outReq.Header.Del("Transfer-Encoding")
	outReq.Header.Del("Content-Length")
	outReq.Header.Del("Authorization")
	outReq.Host = r.Host

	// Measured to headers, not to the last body byte: SSE / NDJSON / long-poll
	// responses stream for as long as the client keeps them open, and folding
	// that into the same histogram would drown the number this exists to show
	// (how long the dev server took to start answering).
	upstreamStartedAt := time.Now()
	upstream, err := p.transport.RoundTrip(outReq)
	if err != nil {
		telemetry.RecordProxy(r.Context(), time.Since(upstreamStartedAt).Milliseconds(), "error")
		p.proxyError(w, r, port, err)
		return
	}
	telemetry.RecordProxy(
		r.Context(),
		time.Since(upstreamStartedAt).Milliseconds(),
		fmt.Sprintf("%dxx", upstream.StatusCode/100),
	)
	defer upstream.Body.Close()

	if upstream.StatusCode >= 500 && p.deps.Log != nil {
		p.deps.Log(fmt.Sprintf("proxy upstream error %s %s port=%d status=%d",
			r.Method, r.URL.Path, port, upstream.StatusCode))
	}

	ct := strings.ToLower(upstream.Header.Get("Content-Type"))
	// Only a plain `200` with a non-HTML *body* means "this dev server isn't a
	// web app" (an API-only server answering `/` with JSON). Every other status
	// carries no body worth judging: a `304 Not Modified` is a cache
	// revalidation of a page the browser already has (and correctly omits
	// Content-Type), a `3xx` points at where the app actually lives, and a
	// `4xx`/`5xx` is a refusal — most often Vite's own 403 "Blocked request.
	// This host is not allowed." Rewriting any of those into a 200 placeholder
	// hides the real status from the browser and from anyone reading the gateway
	// logs, so pass everything but a successful non-HTML body through untouched.
	if r.URL.Path == "/" && upstream.StatusCode == http.StatusOK && !strings.Contains(ct, "text/html") {
		htmlResponse(w, 200, NoWebPageHTML, nil)
		return
	}

	respHeaders := w.Header()
	for k, vv := range upstream.Header {
		lower := strings.ToLower(k)
		switch lower {
		case "x-frame-options", "content-security-policy",
			"content-security-policy-report-only", "content-encoding":
			continue
		}
		for _, v := range vv {
			respHeaders.Add(k, v)
		}
	}
	respHeaders.Set("Access-Control-Allow-Origin", "*")

	if strings.Contains(ct, "text/html") {
		respHeaders.Del("Content-Length")
		raw, err := io.ReadAll(upstream.Body)
		if err != nil {
			raw = []byte{}
		}
		html := string(raw)
		idx := bytes.LastIndex(raw, []byte("</body>"))
		if idx != -1 {
			html = html[:idx] + BootstrapScript + html[idx:]
		} else {
			html = html + BootstrapScript
		}
		w.WriteHeader(upstream.StatusCode)
		io.WriteString(w, html)
		return
	}

	w.WriteHeader(upstream.StatusCode)
	flushCopy(w, upstream.Body)
}

func flushCopy(w http.ResponseWriter, src io.Reader) {
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

func (p *Handler) proxyError(w http.ResponseWriter, r *http.Request, port int, err error) {
	msg := err.Error()
	if p.deps.Log != nil {
		p.deps.Log(fmt.Sprintf("proxy error %s %s port=%d %s", r.Method, r.URL.Path, port, msg))
	}
	// Any navigation, not just `/`: a preview URL shared with a deep path
	// (`/2127?page=1`) is the normal way these links travel, and gating the
	// starting page on the root path turned the dev server's boot window into a
	// bare 502 for everyone who opened one.
	if isConnError(err) && (r.URL.Path == "/" || acceptsHTML(r)) {
		htmlResponse(w, 503, StartingHTML, map[string]string{"Retry-After": "1"})
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(502)
	fmt.Fprintf(w, `{"error":%q}`, "proxy error: "+msg)
}
