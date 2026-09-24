// Command fakedaemon stands in for the sandbox daemon in the docker runtime's
// integration test: the boot env contract, /health, and a bearer-checked
// /_sandbox/config.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
)

func main() {
	token, bootID, port, root := os.Getenv("DAEMON_TOKEN"), os.Getenv("DAEMON_BOOT_ID"), os.Getenv("PROXY_PORT"), os.Getenv("APP_ROOT")
	if token == "" || bootID == "" || port == "" || root == "" {
		fmt.Fprintln(os.Stderr, "fakedaemon: boot env incomplete")
		os.Exit(3)
	}
	// The workdir must be writable under a read-only root.
	if err := os.WriteFile(filepath.Join(root, ".fakedaemon"), []byte("ok"), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "fakedaemon:", err)
		os.Exit(4)
	}
	var configured atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ready": true, "bootId": bootID, "configured": configured.Load(),
			"setup": map[string]bool{"running": false, "done": true},
		})
	})
	mux.HandleFunc("POST /_sandbox/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		configured.Store(true)
		_ = json.NewEncoder(w).Encode(map[string]any{"bootId": bootID, "transition": "bootstrap", "config": body})
	})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
		<-sig
		os.Exit(0)
	}()
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		fmt.Fprintln(os.Stderr, "fakedaemon:", err)
		os.Exit(1)
	}
}
