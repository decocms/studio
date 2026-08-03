package decofile

import "testing"

func TestInvalidBlockJSON(t *testing.T) {
	cases := []struct {
		name    string
		path    string
		content string
		invalid bool
	}{
		{"malformed block", ".deco/blocks/pages-home.json", "{ bad ", true},
		{"valid block", ".deco/blocks/pages-home.json", `{"a":1}`, false},
		{"nested block", "repo/.deco/blocks/nested/x.json", "{", true},
		{"backslash separators", `.deco\blocks\x.json`, "{", true},
		{"uppercase extension", ".deco/blocks/pages-home.JSON", "{ bad", true},
		{"empty content", ".deco/blocks/x.json", "", true},
		{"trailing garbage", ".deco/blocks/x.json", `{"a":1} junk`, true},
		{"jsonc config out of scope", "tsconfig.json", "{ // c\n}", false},
		{"plain json out of scope", "src/data.json", "{ bad", false},
		{"gen artifact out of scope", ".deco/blocks.gen.json", "{ bad", false},
		{"meta artifact out of scope", ".deco/meta.gen.json", "{ bad", false},
		{"non-json in blocks dir", ".deco/blocks/readme.md", "not json", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := InvalidBlockJSON(c.path, c.content)
			if (got != "") != c.invalid {
				t.Fatalf("InvalidBlockJSON(%q, %q) = %q, want invalid=%v", c.path, c.content, got, c.invalid)
			}
		})
	}
}
