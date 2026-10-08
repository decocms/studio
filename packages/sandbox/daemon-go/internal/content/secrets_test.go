package content

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"reflect"
	"strings"
	"testing"
)

// Ported from secrets.test.ts, ciphertext.test.ts and __tests__/fixtures.ts.

const schemaFixtureJSON = `{
  "manifest": {"blocks": {
    "sections": {"hero": {"$ref": "#/definitions/aGVybw=="}, "newsletter": {"$ref": "#/definitions/bmV3c2xldHRlcg=="}},
    "loaders": {"multivariate": {"$ref": "#/definitions/bXY="}, "lazy": {"$ref": "#/definitions/bGF6eQ=="},
                "website/loaders/secret.ts": {"$ref": "#/definitions/djc="}},
    "content": {"settings": {"$ref": "#/definitions/c2V0dGluZ3M="}}
  }},
  "schema": {"definitions": {
    "aGVybw==": {"type": "object", "properties": {"title": {"type": "string"}, "padding": {"type": "string"}}},
    "bmV3c2xldHRlcg==": {"type": "object", "properties": {"listId": {"type": "string"}, "apiKey": {"type": "string", "format": "secret"}}},
    "c2V0dGluZ3M=": {"type": "object", "properties": {
      "integrations": {"type": "array", "items": {"type": "object", "properties": {"token": {"$ref": "#/definitions/U2VjcmV0"}, "label": {"type": "string"}}}},
      "nested": {"anyOf": [{"type": "object", "properties": {"key": {"$ref": "#/definitions/U2VjcmV0"}}}]},
      "extra": {"type": "object", "additionalProperties": {"$ref": "#/definitions/U2VjcmV0"}}
    }},
    "U2VjcmV0": {"type": "string", "format": "secret"},
    "bXY=": {"type": "object", "properties": {"variants": {"type": "array"}}},
    "bGF6eQ==": {"type": "object", "properties": {"value": {}}},
    "djc=": {"type": "object", "properties": {"name": {"type": "string"}, "encrypted": {"type": "string", "format": "secret"}}}
  }}
}`

func mustParse(t *testing.T, text string) any {
	t.Helper()
	v, err := ParseJSON(text)
	if err != nil {
		t.Fatalf("ParseJSON: %v", err)
	}
	return v
}

func b64(n int, b byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{b}, n))
}

func ciphertextWithLengths(key, iv, ct int) string {
	return "v1." + b64(key, 3) + "." + b64(iv, 4) + "." + b64(ct, 5)
}

var validCiphertext = ciphertextWithLengths(384, 12, 32)

func secretJSON(c string) string { return `{"__resolveType":"secret","ciphertext":"` + c + `"}` }

func ruleList(t *testing.T, entry string) []string {
	t.Helper()
	meta, _ := asObject(mustParse(t, schemaFixtureJSON))
	var out []string
	for _, v := range checkSecrets("entry", mustParse(t, entry), meta) {
		out = append(out, v.Rule+"@"+*v.Pointer)
	}
	return out
}

func TestCiphertextFormat(t *testing.T) {
	for _, c := range []string{ciphertextWithLengths(256, 12, 16), ciphertextWithLengths(384, 12, 32), ciphertextWithLengths(512, 12, 1024)} {
		if !isWellFormedCiphertext(c) {
			t.Errorf("refused %s…", c[:20])
		}
	}
	refused := []any{
		"", "v1.", "v1.hunter2", "v1.my-api-key_123", "v1.QUJD.ZGVm",
		"v2" + validCiphertext[2:], ciphertextWithLengths(255, 12, 16), ciphertextWithLengths(384, 16, 32),
		ciphertextWithLengths(384, 12, 15), validCiphertext + ".QUJD", validCiphertext + "==",
		validCiphertext[:len(validCiphertext)-1] + "+", strings.Replace(validCiphertext, ".", ". ", 1),
		"hunter2", 42.0, nil,
	}
	for _, c := range refused {
		if isWellFormedCiphertext(c) {
			t.Errorf("accepted %v", c)
		}
	}
	// Non-canonical base64url (stray low bits) is refused: one value, one spelling.
	if _, ok := decodeBase64URL("QUJE"); !ok {
		t.Error("canonical")
	}
	if _, ok := decodeBase64URL("QUI"); !ok {
		t.Error("unpadded")
	}
	if _, ok := decodeBase64URL("QUJ"); ok {
		t.Error("stray low bits")
	}
}

func publicKeyPEM(t *testing.T) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func TestPublicKeyDerFromPem(t *testing.T) {
	pub := publicKeyPEM(t)
	if publicKeyDerFromPem(pub) == nil || publicKeyDerFromPem("\n  "+pub+"\n\n") == nil {
		t.Error("a single PUBLIC KEY block is accepted, surrounding whitespace too")
	}
	for _, bad := range []string{
		"", "hello", pub + pub, pub + "trailing text",
		strings.ReplaceAll(pub, "PUBLIC KEY", "RSA PRIVATE KEY"),
		strings.Replace(pub, "-----END PUBLIC KEY-----", "-----END PRIVATE KEY-----", 1),
		strings.Replace(pub, "M", "*", 1),
	} {
		if publicKeyDerFromPem(bad) != nil {
			t.Errorf("accepted %q", bad[:min(len(bad), 40)])
		}
	}
	if s := servablePublicKey(&pub); s == nil {
		t.Error("servable")
	}
	withPrivate := pub + "\n# PRIVATE KEY"
	if servablePublicKey(&withPrivate) != nil {
		t.Error("a PRIVATE KEY mention is never served")
	}
	huge := pub + strings.Repeat(" ", 16*1024)
	if servablePublicKey(&huge) != nil {
		t.Error("over 16 KiB")
	}
}

func TestSecretGuard(t *testing.T) {
	newsletter := func(apiKey string) string {
		return `{"__resolveType":"newsletter","listId":"l1","apiKey":` + apiKey + `}`
	}
	expect := func(entry string, want ...string) {
		t.Helper()
		got := ruleList(t, entry)
		if len(want) == 0 {
			want = nil
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s:\n got %v\nwant %v", entry, got, want)
		}
	}
	expect(newsletter(`"hunter2"`), "secret-field@/apiKey")
	for _, v := range []string{`42`, `null`, `{"value":"hunter2"}`, `{"__resolveType":"MyKey"}`} {
		expect(newsletter(v), "secret-field@/apiKey")
	}
	expect(newsletter(secretJSON(validCiphertext)))
	expect(newsletter(secretJSON("hunter2")), "secret-ciphertext@/apiKey")
	expect(newsletter(`{"__resolveType":"secret"}`), "secret-ciphertext@/apiKey")
	expect(`{"__resolveType":"newsletter","listId":"l1"}`)
	expect(`{"__resolveType":"settings",
		"integrations":[{"token":`+secretJSON(validCiphertext)+`,"label":"ok"},{"token":"plain","label":"leak"}],
		"nested":{"key":"plain"},"extra":{"a":`+secretJSON(validCiphertext)+`,"b":"plain"}}`,
		"secret-field@/integrations/1/token", "secret-field@/nested/key", "secret-field@/extra/b")
	expect(`{"__resolveType":"page","sections":[{"__resolveType":"newsletter","apiKey":"plain"},{"__resolveType":"hero","title":"x"}]}`,
		"secret-field@/sections/0/apiKey")
	variants := func(values ...string) string {
		var parts []string
		for _, v := range values {
			parts = append(parts, `{"rule":{"__resolveType":"always"},"value":{"__resolveType":"lazy","value":`+v+`}}`)
		}
		return newsletter(`{"__resolveType":"multivariate","variants":[` + strings.Join(parts, ",") + `]}`)
	}
	expect(variants(secretJSON(validCiphertext), secretJSON(validCiphertext)))
	expect(variants(secretJSON(validCiphertext), `"plain"`), "secret-field@/apiKey/variants/1/value/value")
	expect(newsletter(`{"__resolveType":"multivariate"}`), "secret-field@/apiKey")
	expect(newsletter(`{"__resolveType":"website/flags/multivariate.ts","variants":[{"rule":{"__resolveType":"always"},"value":"plain"}]}`),
		"secret-field@/apiKey/variants/0/value")
	expect(`{"__resolveType":"hero","title":`+secretJSON("bad")+`,"list":[`+secretJSON(validCiphertext)+`]}`, "secret-ciphertext@/title")
	expect(`{"__resolveType":"hero","title":"plain text is fine here"}`)
	expect(`{"__resolveType":"unknown-type","apiKey":"not a known Secret field"}`)
	expect(`{"__resolveType":"settings","extra":{"constructor":"plain","x/~y":"plain"}}`,
		"secret-field@/extra/constructor", "secret-field@/extra/x~1~0y")

	// Where a schema has `properties`, an Object.prototype name is found there
	// (`key in properties` in JS) and never falls back to additionalProperties.
	box, _ := asObject(mustParse(t, `{"manifest":{"blocks":{"s":{"box":{"type":"object","properties":{"title":{"type":"string"}},"additionalProperties":{"type":"string","format":"secret"}}}}}}`))
	inherited := checkSecrets("e", mustParse(t, `{"__resolveType":"box","constructor":"plain","toString":"plain","other":"plain","title":"t"}`), box)
	if len(inherited) != 1 || *inherited[0].Pointer != "/other" {
		t.Errorf("inherited names: %+v", inherited)
	}

	// Without a schema only the ciphertexts are checked.
	noSchema := checkSecrets("e", mustParse(t, `{"__resolveType":"hero","title":`+secretJSON("bad")+`}`), nil)
	if len(noSchema) != 1 || noSchema[0].Rule != "secret-ciphertext" {
		t.Errorf("no schema: %+v", noSchema)
	}
	top := checkSecrets("e", mustParse(t, secretJSON("bad")), nil)
	if len(top) != 1 || *top[0].Pointer != "" {
		t.Errorf("top-level secret block: %+v", top)
	}
}

func TestLegacySecretLoaderIsExempt(t *testing.T) {
	// The v7 loader's `encrypted` is marked format: secret but holds the
	// site's own ciphertext: it is walked without its definition.
	const loader = `"website/loaders/secret.ts"`
	got := ruleList(t, `{"__resolveType":"settings","apps":{"__resolveType":`+loader+`,"name":"API_KEY","encrypted":"0a1b2c"}}`)
	if got != nil {
		t.Errorf("legacy loader: %v", got)
	}
	got = ruleList(t, `{"__resolveType":`+loader+`,"encrypted":`+secretJSON("bad")+`}`)
	if !reflect.DeepEqual(got, []string{"secret-ciphertext@/encrypted"}) {
		t.Errorf("a secret block inside the loader is still checked: %v", got)
	}
	got = ruleList(t, `{"__resolveType":"site/loaders/secret.ts","encrypted":"0a1b2c"}`)
	if got != nil {
		t.Errorf("any app's loaders/secret.ts: %v", got)
	}
}

func TestSecretGuardNamesTheEntry(t *testing.T) {
	meta, _ := asObject(mustParse(t, schemaFixtureJSON))
	v := checkSecrets("Newsletter", mustParse(t, `{"__resolveType":"newsletter","apiKey":"x"}`), meta)
	if len(v) != 1 || v[0].Name != "Newsletter" || v[0].Rule != "secret-field" || *v[0].Pointer != "/apiKey" {
		t.Errorf("%+v", v)
	}
}
