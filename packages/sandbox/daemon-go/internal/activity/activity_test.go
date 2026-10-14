package activity

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStampFollowsBumpWithinASecond(t *testing.T) {
	path := filepath.Join(t.TempDir(), "activity")
	go Stamp(path, time.Hour)

	Bump()
	want := Idle().LastActivityAt
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if st, err := os.Stat(path); err == nil &&
			st.ModTime().UTC().Format("2006-01-02T15:04:05.000Z") == want {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("stamp never reached %s", want)
}
