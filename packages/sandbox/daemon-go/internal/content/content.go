package content

// Turns a storage snapshot into the entry map, applying the file-name rule:
// decode once, resolve spellings, report the rest. Ported from
// server/content.ts and server/bodyCache.ts.

import (
	"container/list"
	"sort"
	"strconv"
	"sync"
)

const (
	maxBlockBytes     = 1 * 1024 * 1024
	maxSnapshotReads  = 3
	defaultCacheBytes = 32 * 1024 * 1024
)

type parsedBody struct {
	ok      bool
	value   *Object
	kind    string // invalid-json | not-an-object | too-large
	message string
	bytes   int
}

// parseBody parses one stored entry, enforcing the per-entry byte limit.
func parseBody(text string) parsedBody {
	bytes := len(text)
	if bytes > maxBlockBytes {
		return parsedBody{kind: "too-large", bytes: bytes, message: "the file is over " + strconv.Itoa(maxBlockBytes) + " bytes"}
	}
	v, err := ParseJSON(text)
	if err != nil {
		// OPEN: the message is this parser's, not V8's.
		return parsedBody{kind: "invalid-json", bytes: bytes, message: err.Error()}
	}
	o, ok := asObject(v)
	if !ok {
		return parsedBody{kind: "not-an-object", bytes: bytes, message: "the file doesn't hold a JSON object"}
	}
	return parsedBody{ok: true, value: o, bytes: bytes}
}

// bodyCache is a bounded LRU of parsed bodies keyed by file and version.
type bodyCache struct {
	mu       sync.Mutex
	maxBytes int
	total    int
	order    *list.List // front: oldest
	entries  map[string]*list.Element
}

type cacheItem struct {
	key  string
	body parsedBody
}

func newBodyCache(maxBytes int) *bodyCache {
	return &bodyCache{maxBytes: maxBytes, order: list.New(), entries: map[string]*list.Element{}}
}

func (c *bodyCache) get(file, version string) (parsedBody, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[file+"\x00"+version]
	if !ok {
		return parsedBody{}, false
	}
	c.order.MoveToBack(e)
	return e.Value.(*cacheItem).body, true
}

func (c *bodyCache) set(file, version string, body parsedBody) {
	if body.bytes > c.maxBytes {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	key := file + "\x00" + version
	if e, ok := c.entries[key]; ok {
		c.total -= e.Value.(*cacheItem).body.bytes
		c.order.Remove(e)
	}
	c.entries[key] = c.order.PushBack(&cacheItem{key: key, body: body})
	c.total += body.bytes
	for c.total > c.maxBytes {
		oldest := c.order.Front()
		item := oldest.Value.(*cacheItem)
		c.order.Remove(oldest)
		delete(c.entries, item.key)
		c.total -= item.body.bytes
	}
}

type loadedEntry struct {
	File    string
	Version string
	Value   *Object // nil when the body wasn't needed
}

type namedEntry struct {
	Name string
	loadedEntry
}

type diagnostic struct {
	File    string
	Kind    string
	Message string
	Name    string // shadowed only
	Winner  string // shadowed only
}

func (d diagnostic) json() *Object {
	o := NewObject("file", d.File, "kind", d.Kind)
	if d.Kind == "shadowed" {
		o.Set("name", d.Name)
		o.Set("winner", d.Winner)
	}
	o.Set("message", d.Message)
	return o
}

type loadedContent struct {
	snapshot storageSnapshot
	// entries in file-name order of the winning files
	entries []namedEntry
	// every saved-block file by spelling key, keys in first-seen order
	groupOrder  []string
	groups      map[string][]storageFile
	diagnostics []diagnostic
	moved       bool
}

func (h *Handler) loadContent(snap storageSnapshot, readAll bool) (*loadedContent, error) {
	var files []storageFile
	for _, f := range snap.Files {
		if IsBlockFileName(f.File) {
			files = append(files, f)
		}
	}
	c := &loadedContent{snapshot: snap, groups: map[string][]storageFile{}}
	for _, f := range files {
		key, _ := FullyDecodeFileName(f.File)
		if _, ok := c.groups[key]; !ok {
			c.groupOrder = append(c.groupOrder, key)
		}
		c.groups[key] = append(c.groups[key], f)
	}

	parsed := map[string]parsedBody{}
	var toRead []storageFile
	for _, key := range c.groupOrder {
		group := c.groups[key]
		if !readAll && len(group) < 2 {
			continue
		}
		for _, f := range group {
			if f.Size > maxBlockBytes {
				parsed[f.File] = parsedBody{kind: "too-large", bytes: int(f.Size), message: "the file is over " + strconv.Itoa(maxBlockBytes) + " bytes"}
				continue
			}
			if hit, ok := h.cache.get(f.File, f.Version); ok {
				parsed[f.File] = hit
			} else {
				toRead = append(toRead, f)
			}
		}
	}
	if len(toRead) > 0 {
		names := make([]string, len(toRead))
		for i, f := range toRead {
			names[i] = f.File
		}
		bodies, err := h.store.readFiles(names)
		if err != nil {
			return nil, err
		}
		for _, f := range toRead {
			read, ok := bodies[f.File]
			if !ok {
				c.moved = true // vanished since the snapshot
				continue
			}
			body := parseBody(read.Text)
			// Cached under the version of the bytes actually read.
			h.cache.set(f.File, read.Version, body)
			if read.Version != f.Version {
				c.moved = true
				continue
			}
			parsed[f.File] = body
		}
	}

	var candidates []*spellingCandidate
	for _, f := range files {
		body, ok := parsed[f.File]
		if !ok {
			if !readAll {
				candidates = append(candidates, &spellingCandidate{File: f.File, Version: f.Version})
			}
			continue
		}
		if !body.ok {
			c.diagnostics = append(c.diagnostics, diagnostic{File: f.File, Kind: body.kind, Message: body.message})
			continue
		}
		candidates = append(candidates, &spellingCandidate{File: f.File, Version: f.Version, HasPath: entryHasPath(body.value), Value: body.value})
	}

	for _, r := range resolveSpellings(candidates) {
		c.entries = append(c.entries, namedEntry{Name: r.Name, loadedEntry: loadedEntry{File: r.Winner.File, Version: r.Winner.Version, Value: r.Winner.Value}})
		for _, loser := range r.Shadowed {
			c.diagnostics = append(c.diagnostics, diagnostic{
				File: loser.File, Kind: "shadowed", Name: r.Name, Winner: r.Winner.File,
				Message: `another spelling of "` + r.Name + `" wins: ` + r.Winner.File,
			})
		}
	}
	sort.SliceStable(c.diagnostics, func(i, j int) bool {
		return compareJS(c.diagnostics[i].File, c.diagnostics[j].File) < 0
	})
	return c, nil
}

// loadCurrentContent takes a snapshot and loads it, taking a new one when a
// file changed while its body was read. shortCircuit ends the read right
// after the snapshot (a conditional read that's "not modified").
func (h *Handler) loadCurrentContent(readAll bool, shortCircuit func(storageSnapshot) bool) (storageSnapshot, *loadedContent, error) {
	for read := 1; read <= maxSnapshotReads; read++ {
		snap, err := h.store.snapshot()
		if err != nil {
			return snap, nil, err
		}
		if shortCircuit != nil && shortCircuit(snap) {
			return snap, nil, nil
		}
		c, err := h.loadContent(snap, readAll)
		if err != nil {
			return snap, nil, err
		}
		if !c.moved {
			return snap, c, nil
		}
	}
	return storageSnapshot{}, nil, errUnavailable("saved blocks kept changing while being read; retry shortly", 250)
}
