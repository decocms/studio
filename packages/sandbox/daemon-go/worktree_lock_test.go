package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// Concurrent writers to one shared checkout is the whole premise of a shared
// sandbox, and /edit is read-modify-write: without serialization the reads
// interleave and every writer but the last loses its append.
func TestTreeGuardedSerializesReadModifyWrite(t *testing.T) {
	file := filepath.Join(t.TempDir(), "shared.txt")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	// Stands in for /edit: read, modify, write back.
	appendLine := func(w http.ResponseWriter, r *http.Request) {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Error(err)
			return
		}
		next := string(raw) + r.Header.Get("x-line") + "\n"
		if err := os.WriteFile(file, []byte(next), 0o644); err != nil {
			t.Error(err)
		}
	}

	const writers = 50
	d := &daemon{}
	handler := d.treeGuarded(appendLine)

	var wg sync.WaitGroup
	for i := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest("POST", "/edit", nil)
			r.Header.Set("x-line", strconv.Itoa(i))
			handler(httptest.NewRecorder(), r)
		}()
	}
	wg.Wait()

	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	got := len(strings.Fields(string(raw)))
	if got != writers {
		t.Fatalf("lost updates: %d of %d writes survived", got, writers)
	}
}
