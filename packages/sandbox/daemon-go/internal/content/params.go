package content

// Parameter validation for the four methods, ported from params.ts (a zod 4
// strictObject per method). Unknown parameters are refused, so a guard the
// server doesn't understand never turns into an unguarded write. Messages
// follow zod 4's wording; like zod, a `__proto__` key is never validated.

import (
	"strconv"
	"strings"
)

const maxOpaqueLength = 1024

func jsTypeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	}
	return "object"
}

type issues []string

func (is *issues) add(path, message string) {
	*is = append(*is, path+": "+message)
}

// opaque is z.string().min(1).max(1024) (nullable: also null).
func (is *issues) opaque(path string, v any, nullable bool) {
	if v == nil && nullable {
		return
	}
	if s, ok := v.(string); ok {
		n := jsLength(s)
		if n < 1 {
			is.add(path, "Too small: expected string to have >=1 characters")
		} else if n > maxOpaqueLength {
			is.add(path, "Too big: expected string to have <=1024 characters")
		}
		return
	}
	is.add(path, "Invalid input: expected string, received "+jsTypeName(v))
	// zod 4 still runs the length checks on anything with a length.
	if list, ok := v.([]any); ok {
		if len(list) < 1 {
			is.add(path, "Too small: expected array to have >=1 items")
		} else if len(list) > maxOpaqueLength {
			is.add(path, "Too big: expected array to have <=1024 items")
		}
	}
}

var paramShapes = map[string][]string{
	"describe":     {},
	"schema.get":   {"ifNoneMatch"},
	"blocks.list":  {"ifNoneMatch"},
	"blocks.apply": {"set", "delete", "ifMatch"},
}

// validateParams checks params for method (present is false when the request
// had no `params`, which reads as {}).
func validateParams(method string, params any, present bool) *ProtocolError {
	if !present {
		return nil
	}
	obj, ok := asObject(params)
	if !ok {
		return errInvalidParams("params must be an object")
	}
	shape := paramShapes[method]
	var is issues
	for _, key := range shape {
		v, has := obj.Get(key)
		if !has {
			continue
		}
		switch key {
		case "ifNoneMatch":
			is.opaque(key, v, false)
		case "set":
			if _, ok := asObject(v); !ok {
				is.add(key, "Invalid input: expected record, received "+jsTypeName(v))
			}
		case "delete":
			list, ok := v.([]any)
			if !ok {
				is.add(key, "Invalid input: expected array, received "+jsTypeName(v))
				break
			}
			for i, item := range list {
				if _, ok := item.(string); !ok {
					is.add(key+"."+strconv.Itoa(i), "Invalid input: expected string, received "+jsTypeName(item))
				}
			}
		case "ifMatch":
			record, ok := asObject(v)
			if !ok {
				is.add(key, "Invalid input: expected record, received "+jsTypeName(v))
				break
			}
			for _, k := range record.Keys() {
				if k == "__proto__" {
					continue
				}
				item, _ := record.Get(k)
				is.opaque(key+"."+k, item, true)
			}
		}
	}
	var unknown []string
	for _, k := range obj.Keys() {
		if k == "__proto__" {
			continue
		}
		known := false
		for _, s := range shape {
			if s == k {
				known = true
				break
			}
		}
		if !known {
			unknown = append(unknown, `"`+k+`"`)
		}
	}
	if len(unknown) == 1 {
		is = append(is, "unknown parameter "+unknown[0])
	} else if len(unknown) > 1 {
		is = append(is, "unknown parameters "+strings.Join(unknown, ", "))
	}
	if len(is) > 0 {
		return errInvalidParams(strings.Join(is, "; "))
	}
	return nil
}
