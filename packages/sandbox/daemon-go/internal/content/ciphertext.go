package content

// The `secret` block's ciphertext format and the secrets public key, ported
// from `@decocms/blocks` v8/ciphertext.ts:
//
//	v1.<wrappedKey>.<iv>.<ciphertext>
//
// each segment canonical unpadded base64url; wrappedKey 256/384/512 bytes, iv
// 12 bytes, ciphertext at least 16 (the GCM tag).

import (
	"encoding/base64"
	"regexp"
	"strings"
)

var ciphertextPattern = regexp.MustCompile(`^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`)

// decodeBase64URL decodes canonical unpadded base64url; ok is false otherwise.
func decodeBase64URL(text string) ([]byte, bool) {
	if len(text)%4 == 1 {
		return nil, false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(text)
	if err != nil {
		return nil, false
	}
	return b, base64.RawURLEncoding.EncodeToString(b) == text
}

// isWellFormedCiphertext reports a well-formed secret ciphertext.
func isWellFormedCiphertext(v any) bool {
	text, ok := v.(string)
	if !ok || !ciphertextPattern.MatchString(text) {
		return false
	}
	parts := strings.Split(text, ".")
	key, ok1 := decodeBase64URL(parts[1])
	iv, ok2 := decodeBase64URL(parts[2])
	ct, ok3 := decodeBase64URL(parts[3])
	if !ok1 || !ok2 || !ok3 {
		return false
	}
	switch len(key) {
	case 256, 384, 512:
	default:
		return false
	}
	return len(iv) == 12 && len(ct) >= 16
}

// isJSWhitespace is JS's \s (WhiteSpace and LineTerminator).
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func jsTrim(s string) string {
	return strings.TrimFunc(s, isJSWhitespace)
}

var pemBodyPattern = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)

// pemBlock is one `-----BEGIN X-----…-----END X-----` match.
type pemBlock struct {
	start, end int
	label      string
	body       string
}

// pemBlocks finds every match of /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/g.
func pemBlocks(pem string) []pemBlock {
	var out []pemBlock
	const begin = "-----BEGIN "
	from := 0
	for from < len(pem) {
		at := strings.Index(pem[from:], begin)
		if at < 0 {
			break
		}
		start := from + at
		i := start + len(begin)
		j := i
		for j < len(pem) && (pem[j] == ' ' || pem[j] >= 'A' && pem[j] <= 'Z') {
			j++
		}
		if j == i || !strings.HasPrefix(pem[j:], "-----") {
			from = start + 1
			continue
		}
		label := pem[i:j]
		bodyStart := j + 5
		end := "-----END " + label + "-----"
		k := strings.Index(pem[bodyStart:], end)
		if k < 0 {
			from = start + 1
			continue
		}
		out = append(out, pemBlock{start: start, end: bodyStart + k + len(end), label: label, body: pem[bodyStart : bodyStart+k]})
		from = bodyStart + k + len(end)
	}
	return out
}

// atob is the WHATWG forgiving-base64 decode (whitespace already removed).
func atob(s string) ([]byte, bool) {
	if len(s)%4 == 0 {
		s = strings.TrimSuffix(s, "=")
		s = strings.TrimSuffix(s, "=")
	}
	if len(s)%4 == 1 || strings.ContainsAny(s, "=") {
		return nil, false
	}
	b, err := base64.RawStdEncoding.DecodeString(s)
	return b, err == nil
}

// publicKeyDerFromPem returns the DER bytes of a single `PUBLIC KEY` PEM
// block, nil for anything else.
func publicKeyDerFromPem(pem string) []byte {
	blocks := pemBlocks(pem)
	if len(blocks) != 1 || blocks[0].label != "PUBLIC KEY" {
		return nil
	}
	block := blocks[0]
	whole := pem[block.start:block.end]
	// String.prototype.replace with a string pattern: the first occurrence.
	rest := strings.Replace(pem, whole, "", 1)
	if jsTrim(rest) != "" {
		return nil
	}
	body := strings.Map(func(r rune) rune {
		if isJSWhitespace(r) {
			return -1
		}
		return r
	}, block.body)
	if !pemBodyPattern.MatchString(body) {
		return nil
	}
	der, ok := atob(body)
	if !ok {
		return nil
	}
	return der
}
