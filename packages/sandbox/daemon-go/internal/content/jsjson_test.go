package content

import (
	"math"
	"testing"
)

// Expected strings are what V8's JSON.stringify / Number#toString print.
func TestFormatNumberMatchesJS(t *testing.T) {
	cases := map[float64]string{
		0: "0", math.Copysign(0, -1): "0", 42: "42", -7: "-7", 0.1: "0.1",
		1e21: "1e+21", 1e20: "100000000000000000000", 1e-7: "1e-7", 1e-6: "0.000001",
		123456789012345680000: "123456789012345680000", 9007199254740991: "9007199254740991",
		5e-324: "5e-324", 1.7976931348623157e308: "1.7976931348623157e+308",
		1.5e-7: "1.5e-7", 0.000123: "0.000123", 1.25e21: "1.25e+21", 100: "100", 0.5: "0.5",
	}
	for f, want := range cases {
		if got := FormatNumber(f); got != want {
			t.Errorf("FormatNumber(%v) = %q, want %q", f, got, want)
		}
	}
}

func TestStringifyMatchesJSONStringify(t *testing.T) {
	cases := []struct{ in, compact, pretty string }{
		{`{"b":1,"a":[true,null],"10":"x","2":{}}`, `{"2":{},"10":"x","b":1,"a":[true,null]}`,
			"{\n  \"2\": {},\n  \"10\": \"x\",\n  \"b\": 1,\n  \"a\": [\n    true,\n    null\n  ]\n}"},
		{`[]`, `[]`, `[]`},
		{`{"s":"\u0000\u001f\n\t\"\\\/<>&\u2028\u00e9"}`, "{\"s\":\"\\u0000\\u001f\\n\\t\\\"\\\\/<>&\u2028é\"}", ""},
		{`{"lone":"\ud800x\udfff","pair":"\ud83d\ude00"}`, "{\"lone\":\"\\ud800x\\udfff\",\"pair\":\"😀\"}", ""},
		{`{"n":[1E2,-0,1e400,0.1e-6]}`, `{"n":[100,0,null,1e-7]}`, ""},
		{`{"a":1,"a":2,"b":3}`, `{"a":2,"b":3}`, ""},
		{`{"4294967294":1,"4294967295":2,"01":3,"0":4}`, `{"0":4,"4294967294":1,"4294967295":2,"01":3}`, ""},
	}
	for _, c := range cases {
		v, err := ParseJSON(c.in)
		if err != nil {
			t.Fatalf("ParseJSON(%s): %v", c.in, err)
		}
		if got := Stringify(v, 0); got != c.compact {
			t.Errorf("Stringify(%s) = %s, want %s", c.in, got, c.compact)
		}
		if c.pretty != "" {
			if got := Stringify(v, 2); got != c.pretty {
				t.Errorf("Stringify(%s, 2) = %q, want %q", c.in, got, c.pretty)
			}
		}
	}
}

func TestParseJSONRejectsWhatJSONParseRejects(t *testing.T) {
	for _, in := range []string{
		"", "{", "{not json", "[1,]", `{"a":1,}`, "01", "1.", ".5", "+1", "NaN", "'x'",
		"\"\t\"", `"\x"`, `"\u12"`, "[1] 2", "tru", "\ufeff{}", "{\"a\" 1}",
	} {
		if _, err := ParseJSON(in); err == nil {
			t.Errorf("ParseJSON(%q) succeeded", in)
		}
	}
	for _, in := range []string{" {} ", "\t\n\r[ ]", "-0", "1e5", "\"\\u00e9\""} {
		if _, err := ParseJSON(in); err != nil {
			t.Errorf("ParseJSON(%q): %v", in, err)
		}
	}
}

func TestDecodeUTF8LikeTextDecoder(t *testing.T) {
	// One U+FFFD per maximal invalid subpart, a BOM stripped.
	got, _ := decodeUTF8([]byte{0xEF, 0xBB, 0xBF, 'a', 0xE2, 0x82, 'b', 0xED, 0xA0, 0x80, 0xFF}, false, true)
	if want := "a\uFFFDb\uFFFD\uFFFD\uFFFD\uFFFD"; got != want {
		t.Errorf("decodeUTF8 = %q, want %q", got, want)
	}
	if _, ok := decodeUTF8([]byte{0xC3}, true, true); ok {
		t.Error("fatal decode accepted invalid UTF-8")
	}
	kept, _ := decodeUTF8([]byte{0xEF, 0xBB, 0xBF, 'x'}, false, false)
	if kept != "\uFEFFx" {
		t.Errorf("BOM not kept: %q", kept)
	}
}

func TestCompareJSUsesUTF16Order(t *testing.T) {
	// In UTF-8 byte order U+1F600 sorts after U+FF5E; in UTF-16 (JS) it sorts before.
	if compareJS("\U0001F600", "\uFF5E") >= 0 {
		t.Error("a surrogate pair must sort before U+FF5E, as in JS")
	}
	if compareJS("a", "b") >= 0 || compareJS("b", "a") <= 0 || compareJS("a", "a") != 0 || compareJS("a", "ab") >= 0 {
		t.Error("ASCII order")
	}
}
