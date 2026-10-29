package setup

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

func setCheckingOut(o *Orchestrator, v bool) {
	o.mu.Lock()
	o.checkingOut = v
	o.mu.Unlock()
}

// A dispatch can land between the config push that queues the clone and the
// drain that starts it, so a queued clone counts; and a clone that fails still
// ends the checkout, or every later run would wait out the stall budget.
func TestCheckoutInFlight(t *testing.T) {
	o := &Orchestrator{deps: OrchestratorDeps{Store: config.NewStore()}}
	if o.CheckoutInFlight() {
		t.Fatal("in flight with nothing queued")
	}
	o.queue = []Step{StepInstall}
	if o.CheckoutInFlight() {
		t.Fatal("an install step counted as a checkout")
	}
	o.queue = []Step{StepClone}
	if !o.CheckoutInFlight() {
		t.Fatal("a queued clone did not count")
	}
	o.queue = nil
	setCheckingOut(o, true)
	if !o.CheckoutInFlight() {
		t.Fatal("a running clone did not count")
	}
	// No config: the step fails.
	if o.stepClone() {
		t.Fatal("clone step succeeded without a config")
	}
	if o.CheckoutInFlight() {
		t.Fatal("a failed clone step left the checkout in flight")
	}
}

func TestWaitCheckout(t *testing.T) {
	prev := checkoutPoll
	checkoutPoll = 5 * time.Millisecond
	t.Cleanup(func() { checkoutPoll = prev })

	newOrch := func(t *testing.T) (*Orchestrator, string) {
		repoDir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(repoDir, ".git", "objects", "pack"), 0o755); err != nil {
			t.Fatal(err)
		}
		o := &Orchestrator{deps: OrchestratorDeps{RepoDir: repoDir}}
		setCheckingOut(o, true)
		return o, repoDir
	}
	// Keeps the step alive for `d`, making progress through `tick`, then ends it.
	runFor := func(o *Orchestrator, d time.Duration, tick func()) {
		go func() {
			for end := time.Now().Add(d); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
				if tick != nil {
					tick()
				}
			}
			setCheckingOut(o, false)
		}()
	}

	t.Run("returns at once with no checkout", func(t *testing.T) {
		o := &Orchestrator{}
		if !o.WaitCheckout(time.Hour) {
			t.Fatal("reported a stall with nothing to wait for")
		}
	})

	t.Run("waits for the clone to end", func(t *testing.T) {
		o, _ := newOrch(t)
		runFor(o, 100*time.Millisecond, nil)
		started := time.Now()
		if !o.WaitCheckout(time.Second) {
			t.Fatal("reported a stall on a clone that ended")
		}
		if time.Since(started) < 100*time.Millisecond {
			t.Fatal("returned before the clone ended")
		}
	})

	t.Run("gives up on a clone with no progress", func(t *testing.T) {
		o, _ := newOrch(t)
		started := time.Now()
		if o.WaitCheckout(100 * time.Millisecond) {
			t.Fatal("reported a stalled clone as settled")
		}
		if waited := time.Since(started); waited < 100*time.Millisecond || waited > 2*time.Second {
			t.Fatalf("waited %v on a stall budget of 100ms", waited)
		}
	})

	// A clone running longer than the stall budget is fine while it progresses.
	t.Run("bytes landing under .git are progress", func(t *testing.T) {
		o, repoDir := newOrch(t)
		pack := filepath.Join(repoDir, ".git", "objects", "pack", "tmp_pack")
		runFor(o, 400*time.Millisecond, func() {
			f, err := os.OpenFile(pack, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
			if err == nil {
				f.Write([]byte("x"))
				f.Close()
			}
		})
		if !o.WaitCheckout(100 * time.Millisecond) {
			t.Fatal("gave up on a clone that was still receiving bytes")
		}
	})

	t.Run("setup output is progress", func(t *testing.T) {
		o, _ := newOrch(t)
		runFor(o, 400*time.Millisecond, func() { o.outputSeq.Add(1) })
		if !o.WaitCheckout(100 * time.Millisecond) {
			t.Fatal("gave up on a clone that was still printing")
		}
	})
}
