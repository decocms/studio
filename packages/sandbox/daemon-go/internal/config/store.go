package config

import "sync"

const (
	RejectInvalid     = "invalid"
	RejectImmutable   = "immutable"
	RejectApplyFailed = "apply failed"
)

type ApplyResult struct {
	Applied    bool
	Reason     string
	Detail     string
	Before     *TenantConfig
	After      *TenantConfig
	Transition Transition
}

type ApplyEvent struct {
	Before     *TenantConfig
	After      *TenantConfig
	Transition Transition
}

type Enriched struct {
	TenantConfig
	RuntimePathPrefix string
}

func RuntimePathPrefix(runtime string) string {
	switch runtime {
	case "bun":
		return "export PATH=/opt/bun/bin:$PATH && "
	case "deno":
		return "export PATH=/opt/deno/bin:$PATH && "
	}
	return ""
}

// Store is the single-writer tenant config store: all mutations serialize
// through the apply mutex, subscribers run synchronously inside it.
type Store struct {
	mu          sync.Mutex
	current     *Enriched
	subscribers []func(ApplyEvent)
}

func NewStore() *Store {
	return &Store{}
}

func (s *Store) Read() *Enriched {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
}

func (s *Store) Hydrate(c *TenantConfig) {
	s.mu.Lock()
	s.current = enrich(c)
	s.mu.Unlock()
}

func (s *Store) Clear() {
	s.mu.Lock()
	s.current = nil
	s.mu.Unlock()
}

func (s *Store) Subscribe(fn func(ApplyEvent)) {
	s.mu.Lock()
	s.subscribers = append(s.subscribers, fn)
	s.mu.Unlock()
}

func (s *Store) Apply(patch *Patch) ApplyResult {
	return s.apply(func(*TenantConfig) *Patch { return patch }, false)
}

// ApplyInternal applies a patch computed from the current state without
// notifying subscribers (orchestrator default fills).
func (s *Store) ApplyInternal(compute func(current *TenantConfig) *Patch) ApplyResult {
	return s.apply(compute, true)
}

func (s *Store) apply(compute func(current *TenantConfig) *Patch, silent bool) ApplyResult {
	s.mu.Lock()

	var before *TenantConfig
	if s.current != nil {
		c := s.current.TenantConfig
		before = &c
	}
	patch := compute(before)
	if patch == nil {
		s.mu.Unlock()
		after := before
		if after == nil {
			after = &TenantConfig{}
		}
		return ApplyResult{Applied: true, Before: before, After: after, Transition: Transition{Kind: KindNoOp}}
	}
	merged := DeepMerge(before, patch)

	if reason := Validate(merged); reason != "" {
		s.mu.Unlock()
		return ApplyResult{Reason: RejectInvalid, Detail: reason}
	}

	transition := Classify(before, merged)
	if transition.Kind == KindIdentityConflict {
		s.mu.Unlock()
		return ApplyResult{Reason: RejectImmutable, Detail: transition.Field}
	}

	if transition.Kind == KindNoOp {
		// Still persist. "No-op" classifies the SIDE EFFECT (no re-clone, no
		// restart, no subscriber wake-up), not the write: a patch can carry a
		// field Classify has no arm for — submodule credentials are the live
		// case — and returning `merged` to the caller while dropping it from the
		// store answers 200 with a receipt for a write that never happened.
		// Guarded on non-nil so an inert patch can't claim an unclaimed daemon.
		if s.current != nil {
			s.current = enrich(merged)
		}
		s.mu.Unlock()
		return ApplyResult{Applied: true, Before: before, After: merged, Transition: transition}
	}

	s.current = enrich(merged)
	subs := append([]func(ApplyEvent){}, s.subscribers...)
	s.mu.Unlock()

	if !silent {
		event := ApplyEvent{Before: before, After: merged, Transition: transition}
		for _, fn := range subs {
			func() {
				defer func() { recover() }()
				fn(event)
			}()
		}
	}

	return ApplyResult{Applied: true, Before: before, After: merged, Transition: transition}
}

func enrich(c *TenantConfig) *Enriched {
	return &Enriched{
		TenantConfig:      *c,
		RuntimePathPrefix: RuntimePathPrefix(c.Runtime()),
	}
}
