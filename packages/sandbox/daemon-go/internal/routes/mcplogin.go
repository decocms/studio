package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"

	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
)

// McpLogin drives `claude mcp login --no-browser` so a user can sign in to an
// HTTP MCP server from Studio. Claude Code always redirects to localhost in
// the sandbox, which the user's browser can't reach, so the user pastes the
// failed redirect URL back and Finish types it into the CLI's paste prompt.
// One sign-in at a time per sandbox; starting another cancels the pending one.
type McpLogin struct {
	mu  sync.Mutex
	cur *mcpLoginProc
}

type mcpLoginProc struct {
	cmd      *exec.Cmd
	tty      *os.File
	out      lockedBuffer
	done     chan struct{} // the CLI exited
	drained  chan struct{} // its output is fully read
	name     string
	redirect string // scheme://host/path the callback URL must match
	// abandon kills the proc after mcpLoginAbandoned. Finish stops it once the
	// CLI exits on its own, so a completed login doesn't hold its pty open for
	// up to 10 minutes waiting on a timer that no longer needs to fire.
	abandon *time.Timer
}

const (
	mcpLoginBodyBytes  = 64 * 1024
	mcpLoginURLTimeout = 30 * time.Second
	mcpLoginExchange   = 60 * time.Second
	// A sign-in nobody finishes is killed rather than left waiting forever.
	mcpLoginAbandoned = 10 * time.Minute
)

var (
	mcpServerName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	ansiEscape    = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)
	authURL       = regexp.MustCompile(`https://[^\s\x07\x1b]+redirect_uri=[^\s\x07\x1b]+`)
)

func NewMcpLogin() *McpLogin { return &McpLogin{} }

// Start handles POST /_sandbox/mcp-login — body `{ name, url }`. Adds the
// server to Claude Code's user config and returns `{ authUrl }` to open in
// the user's browser.
func (m *McpLogin) Start(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, mcpLoginBodyBytes)).Decode(&body); err != nil {
		httpx.Error(w, 400, "invalid JSON body")
		return
	}
	u, err := url.Parse(body.URL)
	if !mcpServerName.MatchString(body.Name) || err != nil || u.Scheme != "https" || u.Host == "" {
		httpx.Error(w, 400, "body must be { name: [A-Za-z0-9_-]{1,64}, url: https URL }")
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.cancelLocked()

	ctx, cancel := context.WithTimeout(r.Context(), mcpLoginURLTimeout)
	defer cancel()
	// Remove first so a changed URL replaces the old entry; a missing entry is fine.
	_ = exec.CommandContext(ctx, "claude", "mcp", "remove", "--scope", "user", body.Name).Run()
	if out, err := exec.CommandContext(ctx, "claude", "mcp", "add", "--transport", "http",
		"--scope", "user", body.Name, u.String()).CombinedOutput(); err != nil {
		httpx.Error(w, 500, "claude mcp add failed: "+lastLine(string(out)))
		return
	}

	p := &mcpLoginProc{
		name:    body.Name,
		cmd:     exec.Command("claude", "mcp", "login", body.Name, "--no-browser"),
		done:    make(chan struct{}),
		drained: make(chan struct{}),
	}
	// Wide enough that the CLI never wraps the URL.
	if p.tty, err = pty.StartWithSize(p.cmd, &pty.Winsize{Rows: 40, Cols: 4096}); err != nil {
		httpx.Error(w, 500, "claude mcp login failed to start: "+err.Error())
		return
	}
	go func() { _, _ = p.out.ReadFrom(p.tty); close(p.drained) }()
	go func() { _ = p.cmd.Wait(); close(p.done) }()
	p.abandon = time.AfterFunc(mcpLoginAbandoned, p.kill)

	link, redirect := p.waitForURL(ctx)
	if link == "" {
		p.kill()
		httpx.Error(w, 502, "claude mcp login printed no sign-in URL: "+lastLine(p.text()))
		return
	}
	p.redirect = redirect
	m.cur = p
	httpx.JSON(w, 200, map[string]any{"authUrl": link})
}

// Finish handles POST /_sandbox/mcp-login/finish — body `{ callbackUrl }`,
// the localhost URL the user's browser landed on. Once Claude Code has
// exchanged the code, returns the stored grant so Studio can keep it.
func (m *McpLogin) Finish(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CallbackURL string `json:"callbackUrl"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, mcpLoginBodyBytes)).Decode(&body); err != nil {
		httpx.Error(w, 400, "invalid JSON body")
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.cur
	if p == nil {
		httpx.Error(w, 409, "no sign-in in progress")
		return
	}
	// url.Parse rejects control characters, so nothing but the URL reaches the prompt.
	u, err := url.Parse(strings.TrimSpace(body.CallbackURL))
	if err != nil || u.Scheme+"://"+u.Host+u.Path != p.redirect || u.Query().Get("code") == "" {
		httpx.Error(w, 400, "paste the full address your browser was redirected to ("+p.redirect+"?code=...)")
		return
	}
	if _, err := p.tty.Write([]byte(u.String() + "\r")); err != nil {
		m.cancelLocked()
		httpx.Error(w, 410, "sign-in is no longer waiting; start again")
		return
	}

	select {
	case <-p.done:
	case <-time.After(mcpLoginExchange):
		m.cancelLocked()
		httpx.Error(w, 504, "sign-in did not finish in time")
		return
	}
	m.cur = nil
	select {
	case <-p.drained:
	case <-time.After(time.Second):
	}
	// The CLI already exited on its own; just release its pty instead of
	// leaving it open until the abandonment timer fires.
	p.abandon.Stop()
	_ = p.tty.Close()
	if p.cmd.ProcessState.ExitCode() != 0 {
		httpx.Error(w, 502, lastLine(p.text()))
		return
	}
	grant, err := storedGrant(p.name)
	if err != nil {
		httpx.Error(w, 500, err.Error())
		return
	}
	httpx.JSON(w, 200, grant)
}

// mcpGrant is the part of Claude Code's `mcpOAuth` credential entry that
// Studio needs to call the server and refresh the token itself.
type mcpGrant struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken,omitempty"`
	ExpiresAt    int64  `json:"expiresAt,omitempty"` // epoch ms
	Scope        string `json:"scope,omitempty"`
	ClientID     string `json:"clientId,omitempty"`
	ClientSecret string `json:"clientSecret,omitempty"`
}

func storedGrant(name string) (*mcpGrant, error) {
	raw, err := os.ReadFile(filepath.Join(os.Getenv("CLAUDE_CONFIG_DIR"), ".credentials.json"))
	if err != nil {
		return nil, fmt.Errorf("read Claude Code credentials: %w", err)
	}
	var creds struct {
		McpOAuth map[string]struct {
			ServerName string `json:"serverName"`
			mcpGrant
		} `json:"mcpOAuth"`
	}
	if err := json.Unmarshal(raw, &creds); err != nil {
		return nil, fmt.Errorf("parse Claude Code credentials: %w", err)
	}
	for _, entry := range creds.McpOAuth {
		if entry.ServerName == name && entry.AccessToken != "" {
			return &entry.mcpGrant, nil
		}
	}
	return nil, fmt.Errorf("Claude Code stored no token for %s", name)
}

func (m *McpLogin) cancelLocked() {
	if m.cur != nil {
		m.cur.kill()
		m.cur = nil
	}
}

func (p *mcpLoginProc) kill() {
	p.abandon.Stop()
	_ = p.cmd.Process.Kill()
	_ = p.tty.Close()
}

func (p *mcpLoginProc) text() string { return ansiEscape.ReplaceAllString(p.out.String(), "") }

// waitForURL returns the sign-in URL and the redirect it names, or "" if the
// CLI exits or prints none in time.
func (p *mcpLoginProc) waitForURL(ctx context.Context) (string, string) {
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		if link := authURL.FindString(p.text()); link != "" {
			if u, err := url.Parse(link); err == nil {
				if ru, err := url.Parse(u.Query().Get("redirect_uri")); err == nil && ru.Host != "" {
					return link, ru.Scheme + "://" + ru.Host + ru.Path
				}
			}
		}
		select {
		case <-ctx.Done():
			return "", ""
		case <-p.done:
			return "", ""
		case <-tick.C:
		}
	}
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (b *lockedBuffer) ReadFrom(f *os.File) (int64, error) {
	chunk := make([]byte, 4096)
	var total int64
	for {
		n, err := f.Read(chunk)
		if n > 0 {
			b.mu.Lock()
			b.buf.Write(chunk[:n])
			b.mu.Unlock()
			total += int64(n)
		}
		if err != nil {
			return total, err
		}
	}
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
