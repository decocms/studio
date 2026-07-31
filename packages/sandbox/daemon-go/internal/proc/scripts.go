package proc

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
)

// DiscoverScripts lists package scripts (or deno tasks) in manifest order.
func DiscoverScripts(dir, pm string) []string {
	if pm == "" {
		return []string{}
	}
	if pm == "deno" {
		for _, f := range []string{"deno.json", "deno.jsonc"} {
			if keys, ok := readScriptKeys(filepath.Join(dir, f), "tasks"); ok {
				return keys
			}
		}
		return []string{}
	}
	if keys, ok := readScriptKeys(filepath.Join(dir, "package.json"), "scripts"); ok {
		return keys
	}
	return []string{}
}

func readScriptKeys(path, field string) ([]string, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, false
	}
	section, ok := top[field]
	if !ok {
		return []string{}, true
	}
	keys, err := orderedObjectKeys(section)
	if err != nil {
		return []string{}, true
	}
	return keys, true
}

func orderedObjectKeys(raw json.RawMessage) ([]string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if tok != json.Delim('{') {
		return []string{}, nil
	}
	keys := []string{}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := keyTok.(string)
		keys = append(keys, key)
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return nil, err
		}
	}
	return keys, nil
}
