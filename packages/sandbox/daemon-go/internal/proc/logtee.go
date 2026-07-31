package proc

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// LogTee is an append-mode tee to a single log file. Size is capped by
// rotation-not-truncation: when a write would exceed maxBytes the file is
// unlinked and reopened with a rotation marker.
type LogTee struct {
	mu          sync.Mutex
	path        string
	maxBytes    int64
	f           *os.File
	written     int64
	rotatedOnce bool
}

func NewLogTee(path string, maxBytes int64) *LogTee {
	return &LogTee{path: path, maxBytes: maxBytes}
}

func (t *LogTee) Write(data string) {
	if data == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.writeLocked([]byte(data))
}

func (t *LogTee) writeLocked(buf []byte) {
	if t.written+int64(len(buf)) > t.maxBytes {
		t.rotateLocked()
	}
	if !t.openLocked() {
		return
	}
	if n, err := t.f.Write(buf); err == nil {
		t.written += int64(n)
	}
}

func (t *LogTee) rotateLocked() {
	t.closeLocked()
	os.Remove(t.path)
	t.written = 0
	t.rotatedOnce = true
	if !t.openLocked() {
		return
	}
	marker := fmt.Sprintf("[log rotated at %d bytes]\n", t.maxBytes)
	if n, err := t.f.WriteString(marker); err == nil {
		t.written = int64(n)
	}
}

func (t *LogTee) WriteHeader(label string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	prior := t.written
	if t.f == nil {
		if st, err := os.Stat(t.path); err == nil {
			prior = st.Size()
		}
	}
	if prior > 0 {
		ts := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		t.writeLocked([]byte(fmt.Sprintf("\r\n=== %s %s ===\r\n", ts, label)))
	} else {
		t.writeLocked([]byte(label + "\r\n"))
	}
}

func (t *LogTee) IsTruncated() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.rotatedOnce
}

func (t *LogTee) Close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closeLocked()
}

func (t *LogTee) closeLocked() {
	if t.f == nil {
		return
	}
	t.f.Sync()
	t.f.Close()
	t.f = nil
}

func (t *LogTee) openLocked() bool {
	if t.f != nil {
		return true
	}
	if err := os.MkdirAll(filepath.Dir(t.path), 0o700); err != nil {
		return false
	}
	if st, err := os.Stat(t.path); err == nil {
		t.written = st.Size()
	}
	f, err := os.OpenFile(t.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	t.f = f
	return true
}
