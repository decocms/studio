package content

// The four methods, ported from server/methods/read.ts and apply.ts.

import (
	"math/rand"
	"strconv"
	"strings"
	"time"
)

const (
	maxOpsPerApply     = 500
	maxPublicKeyBytes  = 16 * 1024
	assetsURLPrefix    = "/assets/"
	defaultPollMs      = 2000
	defaultCommitTries = 3
)

// servablePublicKey is the key describe may serve: a single PUBLIC KEY PEM
// block of at most 16 KiB; anything else is never broadcast.
func servablePublicKey(text *string) *string {
	if text == nil || len(*text) > maxPublicKeyBytes || strings.Contains(*text, "PRIVATE KEY") {
		return nil
	}
	if publicKeyDerFromPem(*text) == nil {
		return nil
	}
	return text
}

func (h *Handler) describe() (any, error) {
	desc := h.store.describe()
	stored, err := h.store.readSecretsPublicKey()
	if err != nil {
		return nil, err
	}
	publicKey := servablePublicKey(stored)
	if stored != nil && publicKey == nil {
		h.logf(".deco/secrets.pub isn't a single PUBLIC KEY PEM block; describe reports no key")
	}
	var secrets any
	if publicKey != nil {
		secrets = NewObject("publicKey", *publicKey)
	}
	return NewObject(
		"protocol", "deco-content",
		"version", NewObject("major", 1.0, "minor", 0.0),
		"server", NewObject("name", h.serverName, "version", h.serverVersion),
		"kind", "working-tree",
		"readOnly", false,
		"root", desc.Root,
		"schemaFormat", "deco-meta@1",
		"pollIntervalMs", float64(h.pollIntervalMs),
		"preview", nil,
		"assets", NewObject("dir", desc.AssetsDir, "urlPrefix", assetsURLPrefix, "maxBytes", float64(desc.AssetsMaxBytes)),
		"secrets", secrets,
	), nil
}

// parseSchema parses schema text; a file caught mid-write is Unavailable,
// never served torn.
func parseSchema(text string) (*Object, error) {
	v, err := ParseJSON(text)
	if err != nil {
		return nil, errUnavailable("the schema file is being written; retry shortly", 500)
	}
	o, ok := asObject(v)
	if !ok {
		return nil, errUnavailable("the schema file doesn't hold a JSON object", 500)
	}
	return o, nil
}

func ifNoneMatchOf(params any) (string, bool) {
	v, ok := prop(params, "ifNoneMatch").(string)
	return v, ok
}

func (h *Handler) schemaGet(params any) (any, error) {
	stored, err := h.store.readSchema()
	if err != nil {
		return nil, err
	}
	if stored == nil {
		// No schema yet is a state, not an error; the snapshot still refuses a
		// site without a .deco folder.
		if _, err := h.store.snapshot(); err != nil {
			return nil, err
		}
		return NewObject("notModified", false, "version", nil, "resolvedRef", nil, "schema", nil), nil
	}
	if inm, ok := ifNoneMatchOf(params); ok && inm == stored.Version {
		return NewObject("notModified", true, "version", stored.Version), nil
	}
	meta, err := h.parsedSchemaFor(stored)
	if err != nil {
		return nil, err
	}
	return NewObject("notModified", false, "version", stored.Version, "resolvedRef", nil, "schema", meta), nil
}

// parsedSchemaFor parses a stored schema, reusing the last parse of the same version.
func (h *Handler) parsedSchemaFor(stored *storedSchema) (*Object, error) {
	h.schemaMu.Lock()
	if h.schemaVersion == stored.Version && h.schemaMeta != nil {
		meta := h.schemaMeta
		h.schemaMu.Unlock()
		return meta, nil
	}
	h.schemaMu.Unlock()
	meta, err := parseSchema(stored.Text)
	if err != nil {
		return nil, err
	}
	h.schemaMu.Lock()
	h.schemaVersion, h.schemaMeta = stored.Version, meta
	h.schemaMu.Unlock()
	return meta, nil
}

func (h *Handler) blocksList(params any) (any, error) {
	inm, hasINM := ifNoneMatchOf(params)
	snap, content, err := h.loadCurrentContent(true, func(s storageSnapshot) bool {
		return hasINM && inm == s.Revision
	})
	if err != nil {
		return nil, err
	}
	if content == nil {
		return NewObject("notModified", true, "revision", snap.Revision, "resolvedRef", nil), nil
	}
	blocks, versions := NewObject(), NewObject()
	for _, e := range content.entries {
		if e.Value == nil {
			continue
		}
		blocks.Set(e.Name, e.Value)
		versions.Set(e.Name, e.Version)
	}
	diagnostics := make([]any, len(content.diagnostics))
	for i, d := range content.diagnostics {
		diagnostics[i] = d.json()
	}
	return NewObject(
		"notModified", false,
		"revision", snap.Revision,
		"resolvedRef", nil,
		"blocks", blocks,
		"versions", versions,
		"diagnostics", diagnostics,
	), nil
}

// ---------------------------------------------------------------- blocks.apply

type setOp struct {
	name  string
	value any
}

type guardOp struct {
	name    string
	version any // a string, or nil (must not exist); unvalidated under __proto__
}

type normalizedApply struct {
	set     []setOp
	delete  []string // names to delete that aren't also set
	ifMatch []guardOp
}

func normalize(params any) (*normalizedApply, error) {
	a := &normalizedApply{}
	setNames := map[string]bool{}
	if set, ok := asObject(prop(params, "set")); ok {
		for _, k := range set.Keys() {
			v, _ := set.Get(k)
			a.set = append(a.set, setOp{name: k, value: v})
			setNames[k] = true
		}
	}
	if list, ok := prop(params, "delete").([]any); ok {
		seen := map[string]bool{}
		for _, item := range list {
			name := item.(string)
			if seen[name] {
				continue
			}
			seen[name] = true
			if !setNames[name] {
				a.delete = append(a.delete, name)
			}
		}
	}
	ops := len(a.set) + len(a.delete)
	if ops > maxOpsPerApply {
		return nil, errLimitExceeded(strconv.Itoa(ops)+" names in one blocks.apply; the limit is "+strconv.Itoa(maxOpsPerApply), NewObject("limit", "maxOpsPerApply"))
	}
	if guards, ok := asObject(prop(params, "ifMatch")); ok {
		for _, k := range guards.Keys() {
			v, _ := guards.Get(k)
			a.ifMatch = append(a.ifMatch, guardOp{name: k, version: v})
		}
	}
	return a, nil
}

func nameViolations(name string, vs []NameViolation) []Violation {
	out := make([]Violation, len(vs))
	for i, v := range vs {
		out[i] = Violation{Name: name, Rule: v.Reason, Message: v.Message}
	}
	return out
}

// validateStatic checks everything that doesn't depend on stored content.
func validateStatic(a *normalizedApply, meta *Object) ([]Violation, map[string]string) {
	var violations []Violation
	bodies := map[string]string{}
	bySpelling := map[string]string{}
	for _, op := range a.set {
		violations = append(violations, nameViolations(op.name, checkBlockName(op.name, nil))...)
		key := SpellingKey(op.name)
		if twin, ok := bySpelling[key]; ok {
			violations = append(violations, Violation{Name: op.name, Rule: "spelling-collision", Message: `"` + op.name + `" and "` + twin + `" are spellings of the same entry`})
		} else {
			bySpelling[key] = op.name
		}
		if _, ok := asObject(op.value); !ok {
			violations = append(violations, Violation{Name: op.name, Rule: "not-an-object", Message: "an entry must be a JSON object"})
			continue
		}
		body := SerializeBlock(op.value)
		if len(body) > maxBlockBytes {
			violations = append(violations, Violation{Name: op.name, Rule: "too-large", Message: "the entry is over " + strconv.Itoa(maxBlockBytes) + " bytes"})
			continue
		}
		bodies[op.name] = body
		violations = append(violations, checkSecrets(op.name, op.value, meta)...)
	}
	for _, name := range a.delete {
		violations = append(violations, nameViolations(name, checkDeletedName(name))...)
	}
	return violations, bodies
}

type spelled struct {
	name  string
	entry loadedEntry
}

func entriesBySpelling(c *loadedContent) map[string]spelled {
	out := map[string]spelled{}
	for _, e := range c.entries {
		key, _ := FullyDecodeFileName(e.File)
		out[key] = spelled{name: e.Name, entry: e.loadedEntry}
	}
	return out
}

// validateAgainst checks the rules that depend on the existing entries.
func validateAgainst(c *loadedContent, bySpelling map[string]spelled, a *normalizedApply) []Violation {
	var violations []Violation
	existing := make([]string, 0, len(c.entries))
	for _, e := range c.entries {
		existing = append(existing, e.Name)
	}
	for _, op := range a.set {
		if _, ok := bySpelling[SpellingKey(op.name)]; ok {
			continue
		}
		names := append([]string(nil), existing...)
		for _, other := range a.set {
			if other.name != op.name {
				names = append(names, other.name)
			}
		}
		for _, v := range checkBlockName(op.name, names) {
			if v.Reason == "case-collision" {
				violations = append(violations, Violation{Name: op.name, Rule: v.Reason, Message: v.Message})
			}
		}
	}
	return violations
}

// orderedSet keeps insertion order, like a JS Set.
type orderedSet struct {
	items []string
	has   map[string]bool
}

func (s *orderedSet) add(v string) {
	if s.has == nil {
		s.has = map[string]bool{}
	}
	if !s.has[v] {
		s.has[v] = true
		s.items = append(s.items, v)
	}
}

func (s *orderedSet) remove(v string) {
	if !s.has[v] {
		return
	}
	delete(s.has, v)
	for i, x := range s.items {
		if x == v {
			s.items = append(s.items[:i], s.items[i+1:]...)
			return
		}
	}
}

type applyPlan struct {
	put      []filePut
	delete   []string
	expected map[string]*string
}

// plan writes encode(name) and deletes every other spelling; only guarded
// entries (all their spellings) become commit expectations.
func plan(c *loadedContent, bySpelling map[string]spelled, a *normalizedApply, bodies map[string]string) applyPlan {
	versionOf := map[string]string{}
	for _, f := range c.snapshot.Files {
		if IsBlockFileName(f.File) {
			versionOf[f.File] = f.Version
		}
	}
	groupFiles := func(name string) []string {
		var out []string
		for _, f := range c.groups[SpellingKey(name)] {
			out = append(out, f.File)
		}
		return out
	}
	p := applyPlan{expected: map[string]*string{}}
	putIndex := map[string]int{}
	var deletes orderedSet
	for _, op := range a.set {
		file := BlockFileName(op.name)
		if i, ok := putIndex[file]; ok {
			p.put[i].Content = bodies[op.name]
		} else {
			putIndex[file] = len(p.put)
			p.put = append(p.put, filePut{File: file, Content: bodies[op.name]})
		}
		for _, other := range groupFiles(op.name) {
			if other != file {
				deletes.add(other)
			}
		}
	}
	for _, name := range a.delete {
		file := BlockFileName(name)
		if _, ok := versionOf[file]; ok {
			deletes.add(file)
		}
		if _, ok := bySpelling[SpellingKey(name)]; ok {
			for _, other := range groupFiles(name) {
				deletes.add(other)
			}
		}
	}
	for _, f := range p.put {
		deletes.remove(f.File)
	}
	for _, g := range a.ifMatch {
		for _, file := range append([]string{BlockFileName(g.name)}, groupFiles(g.name)...) {
			if IsBlockFileName(file) {
				if v, ok := versionOf[file]; ok {
					v := v
					p.expected[file] = &v
				} else {
					p.expected[file] = nil
				}
			}
		}
	}
	p.delete = deletes.items
	return p
}

// checkIfMatch compares each guard against the entry under any spelling.
func checkIfMatch(bySpelling map[string]spelled, a *normalizedApply) *Object {
	mismatches := NewObject()
	failed := false
	for _, g := range a.ifMatch {
		var actual any
		if e, ok := bySpelling[SpellingKey(g.name)]; ok {
			actual = e.entry.Version
		}
		if actual != g.version {
			// `mismatches.__proto__ = …` sets the prototype in JS: no own entry.
			if g.name != "__proto__" {
				mismatches.Set(g.name, NewObject("expected", g.version, "actual", actual))
			}
			failed = true
		}
	}
	if failed {
		return mismatches
	}
	return nil
}

// resultFromVersions reports every name written or deleted, plus null for
// each other spelling the commit deleted.
func resultFromVersions(a *normalizedApply, revision string, fileVersions map[string]string, deleted []string) *Object {
	versions := NewObject()
	touched := map[string]bool{}
	for _, op := range a.set {
		if v, ok := fileVersions[BlockFileName(op.name)]; ok {
			versions.Set(op.name, v)
		} else {
			versions.Set(op.name, nil)
		}
		touched[SpellingKey(op.name)] = true
	}
	for _, name := range a.delete {
		versions.Set(name, nil)
		touched[SpellingKey(name)] = true
	}
	for _, file := range deleted {
		name := BlockNameFromFile(file)
		key, _ := FullyDecodeFileName(file)
		if !versions.Has(name) && touched[key] {
			versions.Set(name, nil)
		}
	}
	return NewObject("revision", revision, "versions", versions)
}

func (h *Handler) loadSchemaForApply() (*string, *Object, error) {
	stored, err := h.store.readSchema()
	if err != nil {
		return nil, nil, err
	}
	if stored == nil {
		return nil, nil, nil
	}
	meta, err := h.parsedSchemaFor(stored)
	if err != nil {
		return nil, nil, err
	}
	v := stored.Version
	return &v, meta, nil
}

func (h *Handler) backoff(attempt int) {
	ms := (float64(h.retryMinMs) + rand.Float64()*float64(max(0, h.retryMaxMs-h.retryMinMs))) * float64(attempt)
	if ms > 0 {
		time.Sleep(time.Duration(ms * float64(time.Millisecond)))
	}
}

func (h *Handler) blocksApply(params any) (any, error) {
	a, err := normalize(params)
	if err != nil {
		return nil, err
	}
	for attempt := 1; attempt <= h.maxCommitAttempts; attempt++ {
		schemaVersion, meta, err := h.loadSchemaForApply()
		if err != nil {
			return nil, err
		}
		violations, bodies := validateStatic(a, meta)
		snap, content, err := h.loadCurrentContent(false, nil)
		if err != nil {
			return nil, err
		}
		bySpelling := entriesBySpelling(content)
		violations = append(violations, validateAgainst(content, bySpelling, a)...)
		if len(violations) > 0 {
			return nil, errInvalidBlock(violations)
		}
		if mismatches := checkIfMatch(bySpelling, a); mismatches != nil {
			return nil, errConflict(mismatches)
		}
		p := plan(content, bySpelling, a, bodies)
		if len(p.put) == 0 && len(p.delete) == 0 {
			return resultFromVersions(a, snap.Revision, nil, nil), nil
		}
		result, err := h.store.commit(commitAttempt{
			Put:                   p.put,
			Delete:                p.delete,
			Expected:              p.expected,
			CheckSchema:           len(a.set) > 0,
			ExpectedSchemaVersion: schemaVersion,
		})
		if err != nil {
			return nil, err
		}
		if !result.Stale {
			if h.onCommit != nil {
				files := make([]string, 0, len(p.put)+len(p.delete))
				for _, f := range p.put {
					files = append(files, f.File)
				}
				h.onCommit(append(files, p.delete...))
			}
			return resultFromVersions(a, result.Revision, result.Versions, p.delete), nil
		}
		if attempt < h.maxCommitAttempts {
			h.backoff(attempt)
		}
	}
	return nil, errUnavailable("storage kept changing; gave up after "+strconv.Itoa(h.maxCommitAttempts)+" commit attempts", 250)
}
