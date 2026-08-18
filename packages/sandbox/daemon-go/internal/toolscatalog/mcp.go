package toolscatalog

// Minimal MCP client over Streamable HTTP — just enough to `initialize` and page
// through `tools/list`; the daemon never calls tools itself. Every request is a
// JSON-RPC POST answered as `application/json` or a one-shot `text/event-stream`
// (both accepted); an `Mcp-Session-Id` response header, when present, is
// required on every subsequent request.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// protocolVersion is the version negotiated on initialize and echoed on every
// later request. Bumping it is a wire change — the server validates it.
const protocolVersion = "2025-06-18"

const clientName = "@decocms/sandbox-tools-catalog"

// maxCatalogPages bounds the tools/list pagination loop: a misbehaving or
// malicious endpoint that never returns an empty nextCursor would otherwise
// hang FetchCatalog indefinitely and grow `out` without bound.
const maxCatalogPages = 1000

// maxRPCResponseBytes bounds a single JSON-RPC response body: a misbehaving or
// malicious endpoint could otherwise stream an unbounded body into memory.
// Matches the SSE branch's per-frame buffer cap below.
const maxRPCResponseBytes = 8 * 1024 * 1024

type mcpClient struct {
	http      *http.Client
	url       string
	headers   map[string]string
	sessionID string
	nextID    int
}

type jsonrpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type listToolsResult struct {
	Tools      []Tool `json:"tools"`
	NextCursor string `json:"nextCursor"`
}

// FetchCatalog connects to a Virtual MCP endpoint and lists its tools,
// following the MCP pagination cursor so large orgs aren't silently truncated
// to the first page.
func FetchCatalog(ctx context.Context, ep Endpoint) ([]Tool, error) {
	c := &mcpClient{
		http:    &http.Client{Timeout: 30 * time.Second},
		url:     ep.URL,
		headers: ep.Headers,
	}
	if err := c.initialize(ctx); err != nil {
		return nil, err
	}
	defer c.close(ctx)

	out := []Tool{}
	cursor := ""
	for page := 0; ; page++ {
		if page >= maxCatalogPages {
			return nil, fmt.Errorf("tools/list: exceeded %d pages", maxCatalogPages)
		}
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := c.call(ctx, "tools/list", params)
		if err != nil {
			return nil, err
		}
		var result listToolsResult
		if err := json.Unmarshal(raw, &result); err != nil {
			return nil, fmt.Errorf("tools/list: %w", err)
		}
		out = append(out, result.Tools...)
		if result.NextCursor == "" {
			return out, nil
		}
		cursor = result.NextCursor
	}
}

func (c *mcpClient) initialize(ctx context.Context) error {
	if _, err := c.call(ctx, "initialize", map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": clientName, "version": "1.0.0"},
	}); err != nil {
		return err
	}
	// The server rejects requests made before it observes `initialized`.
	return c.notify(ctx, "notifications/initialized")
}

func (c *mcpClient) close(ctx context.Context) {
	if c.sessionID == "" {
		return
	}
	req, err := http.NewRequestWithContext(ctx, "DELETE", c.url, nil)
	if err != nil {
		return
	}
	c.applyHeaders(req)
	if res, err := c.http.Do(req); err == nil {
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}
}

func (c *mcpClient) applyHeaders(req *http.Request) {
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}
	// The transport rejects a POST whose Accept omits either type.
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Content-Type", "application/json")
	if c.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", c.sessionID)
		req.Header.Set("Mcp-Protocol-Version", protocolVersion)
	}
}

func (c *mcpClient) post(ctx context.Context, payload any) (*http.Response, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	c.applyHeaders(req)
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if sid := res.Header.Get("Mcp-Session-Id"); sid != "" {
		c.sessionID = sid
	}
	return res, nil
}

func (c *mcpClient) notify(ctx context.Context, method string) error {
	res, err := c.post(ctx, map[string]any{"jsonrpc": "2.0", "method": method})
	if err != nil {
		return err
	}
	defer res.Body.Close()
	io.Copy(io.Discard, res.Body)
	if res.StatusCode >= 400 {
		return fmt.Errorf("%s: HTTP %d", method, res.StatusCode)
	}
	return nil
}

func (c *mcpClient) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.nextID++
	res, err := c.post(ctx, map[string]any{
		"jsonrpc": "2.0",
		"id":      c.nextID,
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	raw, err := readRPCBody(res)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", method, err)
	}
	if res.StatusCode >= 400 && raw == nil {
		return nil, fmt.Errorf("%s: HTTP %d", method, res.StatusCode)
	}
	var parsed jsonrpcResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("%s: %w", method, err)
	}
	if parsed.Error != nil {
		return nil, fmt.Errorf("%s: %s (code %d)", method, parsed.Error.Message, parsed.Error.Code)
	}
	return parsed.Result, nil
}

// readRPCBody extracts the JSON-RPC envelope from either a plain JSON body or
// a one-shot SSE stream (the transport's default), where it arrives as the
// first `data:` frame.
func readRPCBody(res *http.Response) (json.RawMessage, error) {
	if !strings.Contains(res.Header.Get("Content-Type"), "text/event-stream") {
		body, err := io.ReadAll(io.LimitReader(res.Body, maxRPCResponseBytes+1))
		if err != nil {
			return nil, err
		}
		if len(body) > maxRPCResponseBytes {
			return nil, fmt.Errorf("response exceeded %d bytes", maxRPCResponseBytes)
		}
		return body, nil
	}
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if data, ok := strings.CutPrefix(line, "data:"); ok {
			return json.RawMessage(strings.TrimSpace(data)), nil
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("event stream closed without a response")
}
