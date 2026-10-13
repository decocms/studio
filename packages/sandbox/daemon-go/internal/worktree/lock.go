// Package worktree serializes mutations of the sandbox's working tree.
//
// One pod holds one checkout, and since shared agent sandboxes every member of
// the org writes to it through the same daemon. The daemon is the only component
// that sees all of those writers, so the serialization has to live here: an
// /edit is read-modify-write and loses an update if two interleave, and a
// publish or discard that runs mid-write commits or destroys a half-written file.
package worktree

import "sync"

// Lock guards the working tree. Held by the mutating fs routes and by every git
// operation that reads or rewrites the whole checkout.
//
// ponytail: one lock for the entire tree, so two writes to unrelated files
// serialize and a publish blocks writers for the length of its push — both
// correct, neither fast. Move to per-path locks (plus a tree-wide RWMutex that
// git takes for write) if write throughput ever shows up in a profile.
type Lock struct {
	mu sync.Mutex
}

// Acquire blocks until the tree is free and returns the release function:
//
//	defer lock.Acquire()()
func (l *Lock) Acquire() func() {
	l.mu.Lock()
	return l.mu.Unlock
}
