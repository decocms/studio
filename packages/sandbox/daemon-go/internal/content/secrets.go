package content

// The secret guard, ported from `@decocms/blocks/protocol` secrets.ts: a
// `Secret` field (schema `format: "secret"`) must hold a `secret` block with a
// well-formed ciphertext, or a variant block whose every value does; every
// `secret` block anywhere must carry a well-formed ciphertext. A legacy (v7)
// secret loader block (`…/loaders/secret.ts`) is walked without its
// definition: its `encrypted` string already holds the site's own ciphertext.

import (
	"regexp"
	"strconv"
	"strings"
)

const (
	secretBlockType = "secret"
	secretFormat    = "secret"
	lazyType        = "lazy"
	maxSecretDepth  = 512
)

var multivariateTypes = map[string]bool{"multivariate": true, "website/flags/multivariate.ts": true}

var legacySecretLoader = regexp.MustCompile(`(^|/)loaders/secret\.ts$`)

var definitionRef = regexp.MustCompile("^#/definitions/([^\\n\\r\u2028\u2029]+)$")

// objectPrototypeKeys are the names `key in object` finds on
// Object.prototype: the secret guard's property lookup sees them on every
// schema object, so they must shadow `additionalProperties` the same way.
var objectPrototypeKeys = map[string]bool{
	"constructor": true, "__defineGetter__": true, "__defineSetter__": true,
	"hasOwnProperty": true, "__lookupGetter__": true, "__lookupSetter__": true,
	"isPrototypeOf": true, "propertyIsEnumerable": true, "toString": true,
	"valueOf": true, "__proto__": true, "toLocaleString": true,
}

func asObject(v any) (*Object, bool) {
	o, ok := v.(*Object)
	return o, ok && o != nil
}

func prop(v any, key string) any {
	if o, ok := asObject(v); ok {
		x, _ := o.Get(key)
		return x
	}
	return nil
}

func resolveTypeOf(v any) (string, bool) {
	s, ok := prop(v, "__resolveType").(string)
	return s, ok
}

func escapePointer(key string) string {
	return strings.ReplaceAll(strings.ReplaceAll(key, "~", "~0"), "/", "~1")
}

func isSecretFieldSchema(schema any) bool {
	f, ok := prop(schema, "format").(string)
	return ok && f == secretFormat
}

// blockIndex maps every manifest block key to its schema, first group wins.
func blockIndex(meta *Object) map[string]any {
	index := map[string]any{}
	var groups []any
	switch b := prop(prop(meta, "manifest"), "blocks").(type) {
	case *Object:
		for _, k := range b.Keys() {
			v, _ := b.Get(k)
			groups = append(groups, v)
		}
	case []any:
		groups = b
	}
	for _, g := range groups {
		group, ok := asObject(g)
		if !ok {
			continue
		}
		for _, k := range group.Keys() {
			if _, seen := index[k]; !seen {
				v, _ := group.Get(k)
				index[k] = v
			}
		}
	}
	return index
}

type secretWalker struct {
	name       string
	meta       *Object
	index      map[string]any
	violations []Violation
}

func (w *secretWalker) report(pointer, rule, message string) {
	p := pointer
	w.violations = append(w.violations, Violation{Name: w.name, Pointer: &p, Rule: rule, Message: message})
}

// definition looks key up in schema.definitions (non-objects read as nil:
// for the guard, a missing definition and a non-object one are the same).
func (w *secretWalker) definition(key string) any {
	switch defs := prop(prop(w.meta, "schema"), "definitions").(type) {
	case *Object:
		v, _ := defs.Get(key)
		return v
	case []any:
		if n, ok := arrayIndex(key); ok && n < uint64(len(defs)) {
			return defs[n]
		}
	}
	return nil
}

func (w *secretWalker) deref(schema any) any {
	current := schema
	for hops := 0; hops < 32; hops++ {
		ref, ok := prop(current, "$ref").(string)
		if _, isObj := asObject(current); !isObj || !ok {
			break
		}
		m := definitionRef.FindStringSubmatch(ref)
		if m == nil {
			return current
		}
		key, ok := decodeURIComponent(m[1])
		if !ok {
			// decodeURIComponent threw: an unexpected throw, as in JS.
			panic(uriError{})
		}
		key = strings.ReplaceAll(strings.ReplaceAll(key, "~1", "/"), "~0", "~")
		current = w.definition(key)
	}
	return current
}

func (w *secretWalker) branches(schema any, depth int) []*Object {
	node, ok := asObject(w.deref(schema))
	if !ok || depth > 16 {
		return nil
	}
	out := []*Object{node}
	for _, combinator := range []string{"allOf", "anyOf", "oneOf"} {
		if list, ok := prop(node, combinator).([]any); ok {
			for _, item := range list {
				out = append(out, w.branches(item, depth+1)...)
			}
		}
	}
	return out
}

func (w *secretWalker) isSecretField(schema any) bool {
	for _, b := range w.branches(schema, 0) {
		if isSecretFieldSchema(b) {
			return true
		}
	}
	return false
}

// propertySchema returns the schema of key; found is false where JS gives undefined.
func (w *secretWalker) propertySchema(schema any, key string) (any, bool) {
	branches := w.branches(schema, 0)
	for _, b := range branches {
		if props, ok := asObject(prop(b, "properties")); ok {
			if v, own := props.Get(key); own {
				return v, true
			}
			if objectPrototypeKeys[key] {
				// An inherited member: never a schema object.
				return nil, true
			}
		}
	}
	for _, b := range branches {
		if ap, ok := asObject(prop(b, "additionalProperties")); ok {
			return ap, true
		}
	}
	return nil, false
}

func (w *secretWalker) itemSchema(schema any) (any, bool) {
	for _, b := range w.branches(schema, 0) {
		if items, ok := asObject(prop(b, "items")); ok {
			return items, true
		}
	}
	return nil, false
}

func (w *secretWalker) checkSecretValue(value any, pointer string, depth int) {
	if depth > maxSecretDepth {
		w.report(pointer, "too-deep", "the value is nested too deeply")
		return
	}
	typ, hasType := resolveTypeOf(value)
	if hasType && typ == secretBlockType {
		w.walkBlock(value.(*Object), pointer, depth)
		return
	}
	if hasType && multivariateTypes[typ] {
		variants, ok := prop(value, "variants").([]any)
		if !ok {
			w.report(pointer, "secret-field", "a Secret field holds a variant block without variants")
			return
		}
		for i, variant := range variants {
			at := pointer + "/variants/" + strconv.Itoa(i)
			v, ok := asObject(variant)
			if !ok {
				w.report(at, "secret-field", "a variant must be an object")
				continue
			}
			if rule, has := v.Get("rule"); has {
				w.walk(rule, nil, false, at+"/rule", depth+1)
			}
			inner, _ := v.Get("value")
			innerAt := at + "/value"
			if t, ok := resolveTypeOf(inner); ok && t == lazyType {
				inner = prop(inner, "value")
				innerAt += "/value"
			}
			w.checkSecretValue(inner, innerAt, depth+1)
		}
		return
	}
	w.report(pointer, "secret-field", `a Secret field must hold a "secret" block with a well-formed ciphertext, never plain text`)
}

func (w *secretWalker) walkBlock(block *Object, pointer string, depth int) {
	typ, _ := resolveTypeOf(block)
	if typ == secretBlockType && !isWellFormedCiphertext(prop(block, "ciphertext")) {
		w.report(pointer, "secret-ciphertext", `a "secret" block must carry a well-formed "ciphertext" (v1.<wrappedKey>.<iv>.<ciphertext>)`)
	}
	var definition any
	hasDefinition := false
	if w.meta != nil && !legacySecretLoader.MatchString(typ) {
		if w.index == nil {
			w.index = blockIndex(w.meta)
		}
		definition, hasDefinition = w.index[typ]
	}
	w.walkObject(block, definition, hasDefinition, pointer, depth)
}

func (w *secretWalker) walkObject(object *Object, schema any, hasSchema bool, pointer string, depth int) {
	for _, key := range object.Keys() {
		if key == "__resolveType" {
			continue
		}
		child, _ := object.Get(key)
		var childSchema any
		hasChild := false
		if hasSchema {
			childSchema, hasChild = w.propertySchema(schema, key)
		}
		w.walk(child, childSchema, hasChild, pointer+"/"+escapePointer(key), depth+1)
	}
}

// walk checks value; hasSchema is false where JS's schema is undefined.
func (w *secretWalker) walk(value any, schema any, hasSchema bool, pointer string, depth int) {
	if depth > maxSecretDepth {
		w.report(pointer, "too-deep", "the value is nested too deeply")
		return
	}
	if hasSchema && w.isSecretField(schema) {
		w.checkSecretValue(value, pointer, depth)
		return
	}
	if list, ok := value.([]any); ok {
		var items any
		hasItems := false
		if hasSchema {
			items, hasItems = w.itemSchema(schema)
		}
		for i, item := range list {
			w.walk(item, items, hasItems, pointer+"/"+strconv.Itoa(i), depth+1)
		}
		return
	}
	obj, ok := asObject(value)
	if !ok {
		return
	}
	if _, typed := resolveTypeOf(obj); typed {
		w.walkBlock(obj, pointer, depth)
		return
	}
	w.walkObject(obj, schema, hasSchema, pointer, depth)
}

// checkSecrets checks one entry against the secret guard. meta is the parsed
// schema; without one only the secret blocks' ciphertexts are checked.
func checkSecrets(name string, entry any, meta *Object) []Violation {
	w := &secretWalker{name: name, meta: meta}
	w.walk(entry, nil, false, "", 0)
	return w.violations
}
