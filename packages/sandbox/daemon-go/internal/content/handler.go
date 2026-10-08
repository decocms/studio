// Package content serves the Deco content protocol (`deco-content` v1:
// JSON-RPC 2.0 with describe, schema.get, blocks.list and blocks.apply, plus
// `PUT …/assets/<name>` uploads) over the sandbox's working tree.
//
// It is a port of the TypeScript reference in `@decocms/blocks/protocol`
// (server/, storage/fs, keys, secrets), behaviour-identical by design: same
// files and bytes, same error codes and shapes, same secret guard. The
// conformance suite `@decocms/blocks/protocol/conformance` runs against it in
// daemon-e2e, so drift fails CI. Port changes from the TS source; don't invent.
package content

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

const maxRequestBytes = 8 * 1024 * 1024

// Options configure a Handler.
type Options struct {
	Store         *FSStore
	ServerName    string
	ServerVersion string
	// OnCommit is called after blocks.apply lands, with the block files
	// (inside .deco/blocks) it wrote or deleted.
	OnCommit func(files []string)
	// OnAsset is called after an upload, with the stored file name.
	OnAsset func(name string)
	// Logf receives errors that become Internal errors.
	Logf func(format string, args ...any)
}

// Handler serves the protocol and uploads for one app root.
type Handler struct {
	store                  *FSStore
	serverName             string
	serverVersion          string
	pollIntervalMs         int
	maxCommitAttempts      int
	retryMinMs, retryMaxMs int
	cache                  *bodyCache
	onCommit               func([]string)
	onAsset                func(string)
	logFn                  func(string, ...any)
	schemaMu               sync.Mutex
	schemaVersion          string
	schemaMeta             *Object
}

// NewHandler builds a handler over a filesystem storage.
func NewHandler(o Options) *Handler {
	h := &Handler{
		store:             o.Store,
		serverName:        o.ServerName,
		serverVersion:     o.ServerVersion,
		pollIntervalMs:    defaultPollMs,
		maxCommitAttempts: defaultCommitTries,
		retryMinMs:        50,
		retryMaxMs:        200,
		cache:             newBodyCache(defaultCacheBytes),
		onCommit:          o.OnCommit,
		onAsset:           o.OnAsset,
		logFn:             o.Logf,
	}
	if h.serverName == "" {
		h.serverName = "deco-blocks"
	}
	if h.serverVersion == "" {
		h.serverVersion = "unknown"
	}
	return h
}

func (h *Handler) logf(format string, args ...any) {
	if h.logFn != nil {
		h.logFn(format, args...)
		return
	}
	slog.Warn("content protocol", "msg", fmt.Sprintf(format, args...))
}

// ---------------------------------------------------------------- HTTP plumbing

var errBodyTooLarge = errors.New("body too large")

type bodyEncodingError struct{ msg string }

func (e *bodyEncodingError) Error() string { return e.msg }

func readLimited(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errBodyTooLarge
	}
	return b, nil
}

// readBody reads at most limit bytes, decompressing a gzip body (the limit
// applies after decompression, so gzip can't bypass it).
func readBody(r *http.Request, limit int64) ([]byte, error) {
	encoding := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding")))
	if encoding == "" {
		encoding = "identity"
	}
	if encoding == "identity" && r.ContentLength > limit {
		return nil, errBodyTooLarge
	}
	if r.Body == nil || r.Body == http.NoBody {
		return []byte{}, nil
	}
	if encoding == "identity" {
		return readLimited(r.Body, limit)
	}
	if encoding != "gzip" {
		return nil, &bodyEncodingError{msg: `unsupported Content-Encoding "` + encoding + `"`}
	}
	zr, err := gzip.NewReader(r.Body)
	if err != nil {
		return nil, &bodyEncodingError{msg: "the gzip body is corrupt"}
	}
	b, err := readLimited(zr, limit)
	if err != nil {
		if errors.Is(err, errBodyTooLarge) {
			return nil, err
		}
		return nil, &bodyEncodingError{msg: "the gzip body is corrupt"}
	}
	return b, nil
}

// jsNumber is JS's Number(string), for the q-values of Accept-Encoding.
func jsNumber(s string) float64 {
	s = jsTrim(s)
	if s == "" {
		return 0
	}
	switch s {
	case "Infinity", "+Infinity":
		return 1
	case "-Infinity":
		return -1
	}
	if len(s) > 2 && s[0] == '0' && strings.ContainsRune("xXoObB", rune(s[1])) {
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[s[1]]
		n, err := strconv.ParseUint(s[2:], base, 64)
		if err != nil {
			return -1
		}
		return float64(n)
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
			return -1 // NaN: never > 0
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		var ne *strconv.NumError
		if errors.As(err, &ne) && errors.Is(ne.Err, strconv.ErrRange) {
			return f
		}
		return -1
	}
	return f
}

func acceptsGzip(r *http.Request) bool {
	header := strings.Join(r.Header.Values("Accept-Encoding"), ", ")
	if header == "" {
		return false
	}
	for _, part := range strings.Split(header, ",") {
		pieces := strings.Split(strings.ToLower(strings.TrimSpace(part)), ";")
		coding := strings.TrimSpace(pieces[0])
		if coding != "gzip" && coding != "*" {
			continue
		}
		q, hasQ := "", false
		for _, p := range pieces[1:] {
			if p = strings.TrimSpace(p); strings.HasPrefix(p, "q=") {
				q, hasQ = p[2:], true
				break
			}
		}
		if !hasQ || jsNumber(q) > 0 {
			return true
		}
	}
	return false
}

const gzipThresholdBytes = 1024

// writeJSON is the TS jsonResponse: JSON, no-store, gzip when accepted.
func writeJSON(w http.ResponseWriter, r *http.Request, body string, status int, extra map[string]string) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Vary", "Accept-Encoding")
	for k, v := range extra {
		h.Set(k, v)
	}
	if len(body) < gzipThresholdBytes || !acceptsGzip(r) {
		h.Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(status)
		io.WriteString(w, body)
		return
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	io.WriteString(zw, body)
	zw.Close()
	h.Set("Content-Encoding", "gzip")
	h.Set("Content-Length", strconv.Itoa(buf.Len()))
	w.WriteHeader(status)
	w.Write(buf.Bytes())
}

func errorBody(e *ProtocolError) string {
	return Stringify(NewObject("jsonrpc", "2.0", "id", nil, "error", e.JSON()), 0)
}

func isJSONContentType(r *http.Request) bool {
	values := r.Header.Values("Content-Type")
	if len(values) == 0 {
		return false
	}
	t := strings.Join(values, ", ")
	return strings.ToLower(strings.TrimSpace(strings.SplitN(t, ";", 2)[0])) == "application/json"
}

// ServeRPC serves the protocol endpoint.
func (h *Handler) ServeRPC(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, r, errorBody(errInvalidRequest("use POST")), 405, map[string]string{"Allow": "POST"})
		return
	}
	if !isJSONContentType(r) {
		writeJSON(w, r, errorBody(errInvalidRequest("Content-Type must be application/json")), 415, nil)
		return
	}
	raw, err := readBody(r, maxRequestBytes)
	if err != nil {
		var enc *bodyEncodingError
		switch {
		case errors.Is(err, errBodyTooLarge):
			writeJSON(w, r, errorBody(errLimitExceeded("the request body is over "+strconv.Itoa(maxRequestBytes)+" bytes", NewObject("limit", "maxRequestBytes"))), 413, nil)
		case errors.As(err, &enc):
			writeJSON(w, r, errorBody(errInvalidRequest(enc.msg)), 415, nil)
		default:
			// The client went away mid-body.
			writeJSON(w, r, errorBody(errInternal()), 500, nil)
		}
		return
	}
	text, ok := decodeUTF8(raw, true, true)
	if !ok {
		writeJSON(w, r, errorBody(errParse()), 200, nil)
		return
	}
	body, err := ParseJSON(text)
	if err != nil {
		writeJSON(w, r, errorBody(errParse()), 200, nil)
		return
	}
	writeJSON(w, r, h.dispatch(body), 200, nil)
}
