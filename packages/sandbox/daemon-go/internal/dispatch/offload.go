package dispatch

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/urlallow"
)

const maxOffloadBytes = 32 * 1024 * 1024

type MessagesRef struct {
	URL    string  `json:"url"`
	Sha256 string  `json:"sha256"`
	Bytes  float64 `json:"bytes"`
}

// ParseMessagesRef extracts a messagesRef from the dispatch frame. nil when
// the frame carries inline messages (non-offload path).
func ParseMessagesRef(frame map[string]json.RawMessage) *MessagesRef {
	raw, ok := frame["messagesRef"]
	if !ok || string(raw) == "null" {
		return nil
	}
	var ref MessagesRef
	if err := json.Unmarshal(raw, &ref); err != nil || ref.URL == "" {
		return nil
	}
	return &ref
}

// AssertAllowedRefUrl enforces the SSRF allowlist on an offloaded messagesRef.
func AssertAllowedRefUrl(raw string, allowedHosts []string, allowSameHostDev bool) error {
	return urlallow.Assert(raw, allowedHosts, allowSameHostDev)
}

func FetchOffloadedMessages(rawUrl string, allowedHosts []string, allowSameHostDev bool, expectedSha256 string) (json.RawMessage, error) {
	if err := AssertAllowedRefUrl(rawUrl, allowedHosts, allowSameHostDev); err != nil {
		return nil, err
	}
	client := urlallow.Client(30*time.Second, allowedHosts, allowSameHostDev)
	var res *http.Response
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(200*(1<<attempt)) * time.Millisecond)
		}
		r, err := client.Get(rawUrl)
		if err != nil {
			lastErr = err
			continue
		}
		if r.StatusCode >= 500 {
			r.Body.Close()
			lastErr = fmt.Errorf("offload fetch %d", r.StatusCode)
			continue
		}
		if r.StatusCode != 200 {
			r.Body.Close()
			return nil, fmt.Errorf("offload fetch %d", r.StatusCode)
		}
		res = r
		break
	}
	if res == nil {
		return nil, lastErr
	}
	defer res.Body.Close()
	if res.ContentLength > maxOffloadBytes {
		return nil, errors.New("offload ref: too large")
	}
	buf, err := io.ReadAll(io.LimitReader(res.Body, maxOffloadBytes+1))
	if err != nil {
		return nil, err
	}
	if len(buf) > maxOffloadBytes {
		return nil, errors.New("offload ref: too large")
	}
	sum := sha256.Sum256(buf)
	actual := hex.EncodeToString(sum[:])
	if expectedSha256 != "" && actual != expectedSha256 {
		return nil, errors.New("offload ref: sha256 mismatch")
	}
	var msgs json.RawMessage
	if err := json.Unmarshal(buf, &msgs); err != nil {
		return nil, err
	}
	return msgs, nil
}
