package probe

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"
)

// A dev server answering every request with 500 is reachable, so Status stays
// online — but HTTPStatus must carry the code so a caller can tell the two
// apart. This is the warm-pool handover bug: `.faststore/src/pages` missing,
// every route 500, watchdog silent.
func TestStateCarriesHTTPStatus(t *testing.T) {
	for _, code := range []int{200, 500} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(code)
		}))
		port := serverPort(t, srv.URL)

		got := make(chan State, 8)
		p := Start(Deps{
			GetPort:  func() int { return port },
			OnChange: func(s State) { got <- s },
			Fast:     5 * time.Millisecond,
			Slow:     5 * time.Millisecond,
		})

		var seen State
		deadline := time.After(3 * time.Second)
	wait:
		for {
			select {
			case s := <-got:
				if s.Status == StatusOnline {
					seen = s
					break wait
				}
			case <-deadline:
				t.Fatalf("code %d: never reported online", code)
			}
		}
		p.Stop()
		srv.Close()

		if seen.HTTPStatus != code {
			t.Fatalf("code %d: HTTPStatus = %d, want %d", code, seen.HTTPStatus, code)
		}
	}
}

func serverPort(t *testing.T, raw string) int {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	n, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	return n
}
