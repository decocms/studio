package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Our log pipeline reads stderr as error severity, so a lifecycle line on
// stderr inflates every pod's error rate. Everything goes through slog (stdout,
// explicit level=).
func TestNoStdlibLogUsage(t *testing.T) {
	err := filepath.WalkDir(".", func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, bad := range []string{"\"log\"\n", "log.Print", "log.Fatal", "os.Stderr"} {
			if strings.Contains(string(src), bad) {
				t.Errorf("%s: uses %q — use slog (stdout) instead", path, strings.TrimSpace(bad))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
