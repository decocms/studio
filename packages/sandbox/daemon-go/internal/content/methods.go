package content

// The read methods (describe, schema.get, blocks.list), ported from
// server/methods/read.ts.

import (
	"strings"
)

const (
	maxPublicKeyBytes = 16 * 1024
	assetsURLPrefix   = "/assets/"
	defaultPollMs     = 2000
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
