package routes

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
)

func bufioScanner(r io.Reader) *bufio.Scanner {
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	return s
}

// maxConfigBytes bounds config-style JSON request bodies (tenant config
// patches, org-fs config) — these are always small hand-written objects, never
// file transfers, so 1MB is generous headroom, not a real ceiling.
const maxConfigBytes = 1024 * 1024

// readLimitedBody reads r.Body capped at maxBytes: without a limit, a
// misbehaving or malicious caller could stream an unbounded body into memory
// and crash the daemon, tearing down the sandbox pod on the next missed
// health probe.
func readLimitedBody(r *http.Request, maxBytes int64) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read body: %s", err.Error())
	}
	if int64(len(raw)) > maxBytes {
		return nil, fmt.Errorf("request body exceeded %d bytes", maxBytes)
	}
	return raw, nil
}
