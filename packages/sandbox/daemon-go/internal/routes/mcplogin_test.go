package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeClaude mimics `claude mcp login --no-browser`: prints a sign-in URL with
// an OSC 8 hyperlink, reads the pasted redirect, and stores a token only for code=good.
const fakeClaude = `#!/bin/sh
[ "$2" = login ] || exit 0
printf 'Visit this URL to authorize:\n  \033]8;;https://auth.example/authorize?redirect_uri=http%%3A%%2F%%2Flocalhost%%3A5555%%2Fcallback&state=s\007https://auth.example/authorize?redirect_uri=http%%3A%%2F%%2Flocalhost%%3A5555%%2Fcallback&state=s\033]8;;\007\nOr paste the redirect URL here: '
read line
case "$line" in
*code=good*)
  printf '{"mcpOAuth":{"figma|0123":{"serverName":"figma","accessToken":"at","refreshToken":"rt","expiresAt":1700000000000,"clientId":"cid"}}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
  echo "Authentication successful"; exit 0 ;;
*) echo "Couldn't complete authentication: bad code"; exit 1 ;;
esac
`

func withFakeClaude(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte(fakeClaude), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
}

func post(h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
	return rec
}

func TestMcpLoginFlow(t *testing.T) {
	withFakeClaude(t)
	m := NewMcpLogin()

	if rec := post(m.Start, `{"name":"figma; rm","url":"https://mcp.example/mcp"}`); rec.Code != 400 {
		t.Fatalf("bad name: status = %d", rec.Code)
	}
	if rec := post(m.Start, `{"name":"figma","url":"http://mcp.example/mcp"}`); rec.Code != 400 {
		t.Fatalf("non-https url: status = %d", rec.Code)
	}
	if rec := post(m.Finish, `{"callbackUrl":"http://localhost:5555/callback?code=good"}`); rec.Code != 409 {
		t.Fatalf("finish before start: status = %d", rec.Code)
	}

	rec := post(m.Start, `{"name":"figma","url":"https://mcp.example/mcp"}`)
	var started struct{ AuthURL string }
	_ = json.Unmarshal(rec.Body.Bytes(), &started)
	if rec.Code != 200 || started.AuthURL != "https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback&state=s" {
		t.Fatalf("start: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	if rec := post(m.Finish, `{"callbackUrl":"http://localhost:6666/callback?code=good"}`); rec.Code != 400 {
		t.Fatalf("wrong port: status = %d", rec.Code)
	}
	rec = post(m.Finish, `{"callbackUrl":"http://localhost:5555/callback?code=good"}`)
	var grant mcpGrant
	_ = json.Unmarshal(rec.Body.Bytes(), &grant)
	if rec.Code != 200 || grant != (mcpGrant{AccessToken: "at", RefreshToken: "rt", ExpiresAt: 1700000000000, ClientID: "cid"}) {
		t.Fatalf("finish: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	post(m.Start, `{"name":"figma","url":"https://mcp.example/mcp"}`)
	rec = post(m.Finish, `{"callbackUrl":"http://localhost:5555/callback?code=bad"}`)
	if rec.Code != 502 || !strings.Contains(rec.Body.String(), "bad code") {
		t.Fatalf("rejected code: status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

// A completed login must release its pty and cancel the abandonment timer
// right away, not hold the fd open for up to mcpLoginAbandoned waiting on a
// timer that no longer needs to fire.
func TestMcpLoginFinishReleasesTty(t *testing.T) {
	withFakeClaude(t)
	m := NewMcpLogin()

	post(m.Start, `{"name":"figma","url":"https://mcp.example/mcp"}`)
	proc := m.cur
	if proc == nil {
		t.Fatal("expected a sign-in in progress after Start")
	}

	rec := post(m.Finish, `{"callbackUrl":"http://localhost:5555/callback?code=good"}`)
	if rec.Code != 200 {
		t.Fatalf("finish: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	if _, err := proc.tty.Write([]byte("x")); err == nil {
		t.Fatal("expected the pty to be closed once Finish completes")
	}
	if proc.abandon.Stop() {
		t.Fatal("expected the abandonment timer to already be stopped")
	}
}
