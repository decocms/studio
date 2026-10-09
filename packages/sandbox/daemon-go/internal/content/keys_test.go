package content

import (
	"reflect"
	"strings"
	"testing"
)

// Ported from keys.test.ts.

func TestBlockFileName(t *testing.T) {
	cases := map[string]string{
		"pages-Home%20Page-6f1e":     "pages-Home%2520Page-6f1e.json",
		"collections/blog/posts/abc": "collections%2Fblog%2Fposts%2Fabc.json",
		"Header":                     "Header.json",
		"pages-Home Page":            "pages-Home%20Page.json",
		"Cores dos preços":           "Cores%20dos%20pre%C3%A7os.json",
		"50% off":                    "50%25%20off.json",
		"a!~*'()b":                   "a!~*'()b.json",
	}
	for name, file := range cases {
		if got := BlockFileName(name); got != file {
			t.Errorf("BlockFileName(%q) = %q, want %q", name, got, file)
		}
	}
}

func TestEncodeURIComponentPanicsOnALoneSurrogate(t *testing.T) {
	defer func() {
		if _, ok := recover().(uriError); !ok {
			t.Error("expected a uriError panic")
		}
	}()
	encodeURIComponent("x\xed\xa0\x80")
}

func TestBlockNameFromFileDecodesOnce(t *testing.T) {
	cases := map[string]string{
		"pages-Home%2520Page-6f1e.json":         "pages-Home%20Page-6f1e",
		"collections%2Fblog%2Fposts%2Fabc.json": "collections/blog/posts/abc",
		"pages-Home%20Page.json":                "pages-Home Page",
		"Header.json":                           "Header",
		"50% off.json":                          "50% off",
		"bad%E0%A4%A.json":                      "bad%E0%A4%A",
		"bad%C0%80.json":                        "bad%C0%80", // overlong: URIError in JS
		"sur%ED%A0%80.json":                     "sur%ED%A0%80",
	}
	for file, name := range cases {
		if got := BlockNameFromFile(file); got != name {
			t.Errorf("BlockNameFromFile(%q) = %q, want %q", file, got, name)
		}
	}
	for _, name := range []string{"a", "pages-Home%20Page-6f1e", "x/y", "50% off", "é ü 世界", "%", "%%25"} {
		if got := BlockNameFromFile(BlockFileName(name)); got != name {
			t.Errorf("round trip of %q gave %q", name, got)
		}
	}
}

func TestSpellings(t *testing.T) {
	check := func(file, name string, passes int) {
		t.Helper()
		n, p := FullyDecodeFileName(file)
		if n != name || p != passes {
			t.Errorf("FullyDecodeFileName(%q) = %q, %d; want %q, %d", file, n, p, name, passes)
		}
	}
	check("pages-Home%2520Page.json", "pages-Home Page", 2)
	check("pages-Home%20Page.json", "pages-Home Page", 1)
	check("Header.json", "Header", 0)
	check("50% off.json", "50% off", 0)
	if SpellingKey("pages-Home%20Page") != SpellingKey("pages-Home Page") || SpellingKey("A%2520B") != "A B" {
		t.Error("spelling keys")
	}

	names := func(rs []resolvedSpelling) []string {
		var out []string
		for _, r := range rs {
			out = append(out, r.Name)
		}
		return out
	}
	// A path wins, then more decoding, then the lowest file name.
	a := &spellingCandidate{File: "pages-Home%2520Page.json"}
	b := &spellingCandidate{File: "pages-Home%20Page.json", HasPath: true}
	if r := resolveSpellings([]*spellingCandidate{a, b}); r[0].Winner != b {
		t.Error("the file with a path must win")
	}
	bot := &spellingCandidate{File: "pages-Home%2520Page.json", HasPath: true}
	legacy := &spellingCandidate{File: "pages-Home%20Page.json", HasPath: true}
	r := resolveSpellings([]*spellingCandidate{legacy, bot})
	if !reflect.DeepEqual(names(r), []string{"pages-Home%20Page"}) || r[0].Winner != bot || r[0].Shadowed[0] != legacy {
		t.Errorf("more decoding must win: %+v", r)
	}
	upper := &spellingCandidate{File: "A%2FB.json"}
	lower := &spellingCandidate{File: "A%2fB.json"}
	if r := resolveSpellings([]*spellingCandidate{lower, upper}); r[0].Winner != upper || r[0].Name != "A/B" {
		t.Error("the lowest file name must win")
	}
	three := resolveSpellings([]*spellingCandidate{{File: "x%2520y.json"}, {File: "x%20y.json"}, {File: "x y.json"}})
	if three[0].Name != "x%20y" || three[0].Shadowed[0].File != "x%20y.json" || three[0].Shadowed[1].File != "x y.json" {
		t.Errorf("three spellings: %+v", three)
	}
	if got := names(resolveSpellings([]*spellingCandidate{{File: "b.json"}, {File: "a.json"}})); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Errorf("distinct names: %v", got)
	}
}

func TestSerializeBlockAndFileNames(t *testing.T) {
	v, _ := ParseJSON(`{"a":1,"b":[true]}`)
	if got := SerializeBlock(v); got != "{\n  \"a\": 1,\n  \"b\": [\n    true\n  ]\n}\n" {
		t.Errorf("SerializeBlock = %q", got)
	}
	for file, want := range map[string]bool{
		"a.json": true, ".json": false, "a.ts": false, "a/b.json": false,
		".env.json": false, "..json": false, ".DS_Store.json": false, `a\b.json`: false,
	} {
		if IsBlockFileName(file) != want {
			t.Errorf("IsBlockFileName(%q) != %v", file, want)
		}
	}
	for entry, want := range map[string]bool{`{"path":"/"}`: true, `{"path":""}`: false, `{"path":1}`: false, `null`: false, `[]`: false} {
		v, _ := ParseJSON(entry)
		if entryHasPath(v) != want {
			t.Errorf("entryHasPath(%s) != %v", entry, want)
		}
	}
}

func reasons(name string, existing []string) []string {
	var out []string
	for _, v := range checkBlockName(name, existing) {
		out = append(out, v.Reason)
	}
	return out
}

func TestCheckBlockName(t *testing.T) {
	cases := [][2]string{
		{"", "empty"}, {`a\b`, "invalid-character"}, {"a\x00b", "invalid-character"},
		{"a..b", "dot-dot"}, {"..", "dot-dot"}, {".env", "leading-dot"}, {".", "leading-dot"},
		{".hidden page", "leading-dot"}, {"__proto__", "reserved"}, {"CON", "device-name"},
		{"con", "device-name"}, {"nul.backup", "device-name"}, {"COM1", "device-name"},
		{"lpt9", "device-name"}, {"widget.ts", "source-extension"}, {"Widget.TSX", "source-extension"},
		{"helper.js", "source-extension"},
	}
	for _, c := range cases {
		got := reasons(c[0], nil)
		found := false
		for _, r := range got {
			found = found || r == c[1]
		}
		if !found {
			t.Errorf("checkBlockName(%q) = %v, want %s", c[0], got, c[1])
		}
	}
	if got := reasons(strings.Repeat("a", 250), nil); got != nil {
		t.Errorf("250 bytes: %v", got)
	}
	if got := reasons(strings.Repeat("a", 251), nil); !reflect.DeepEqual(got, []string{"too-long"}) {
		t.Errorf("251 bytes: %v", got)
	}
	if got := reasons(strings.Repeat("é", 41), nil); got != nil {
		t.Errorf("41 é: %v", got)
	}
	if got := reasons(strings.Repeat("é", 42), nil); !reflect.DeepEqual(got, []string{"too-long"}) {
		t.Errorf("42 é: %v", got)
	}
	if got := reasons("header", []string{"Header"}); !reflect.DeepEqual(got, []string{"case-collision"}) {
		t.Errorf("case collision: %v", got)
	}
	if reasons("Header", []string{"Header"}) != nil || reasons("Footer", []string{"Header"}) != nil {
		t.Error("an update or another name isn't a collision")
	}
	for _, name := range []string{"Header", "pages-Home Page-6f1e", "collections/blog/posts/abc", "COM", "CONsole", "a.json", "a.b", "end."} {
		if got := reasons(name, nil); got != nil {
			t.Errorf("%q: %v", name, got)
		}
	}
	if got := reasons(`x..y\z.ts`, nil); !reflect.DeepEqual(got, []string{"invalid-character", "dot-dot", "source-extension"}) {
		t.Errorf("every rule: %v", got)
	}
	if checkDeletedName("widget.ts") != nil || checkDeletedName("CON") != nil || checkDeletedName("")[0].Reason != "empty" {
		t.Error("deleted names")
	}
}
