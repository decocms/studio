package probe

import (
	"net/http"
	"net/http/httptest"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// TestHeadDoesNotLeakKeepAliveGoroutine guards against regressing to a
// per-tick Transport that leaves an idle keep-alive connection (and its
// readLoop goroutine) open forever, since head() is called repeatedly for
// the life of the daemon.
func TestHeadDoesNotLeakKeepAliveGoroutine(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	port, err := strconv.Atoi(srv.URL[len("http://127.0.0.1:"):])
	if err != nil {
		t.Fatalf("parse port from %q: %v", srv.URL, err)
	}

	before := runtime.NumGoroutine()

	for i := 0; i < 20; i++ {
		status, _, up := head(port)
		if !up || status != 200 {
			t.Fatalf("head() = status=%d up=%v, want 200/true", status, up)
		}
	}

	// Idle keep-alive readLoop goroutines don't exit synchronously; give them
	// a moment, then assert we haven't accumulated one per call.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if runtime.NumGoroutine() <= before+5 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("goroutine count grew from %d to %d after 20 head() calls — keep-alive connections are leaking",
				before, runtime.NumGoroutine())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
