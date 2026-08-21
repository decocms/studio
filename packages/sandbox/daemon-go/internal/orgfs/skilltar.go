package orgfs

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// Fetching a whole skill set as ONE request instead of walking the mount.
//
// The per-file path costs a stat, a presign against the studio, and an S3 GET
// for every file — ~350 round trips for an org with ~120 skills, which measured
// as 40 of the 44 seconds before a run's first token. The studio already knows
// the tree from a single query and reads S3 from inside the datacenter, so
// `GET /api/:org/fs/:volume/skills.tar` hands the set over in one response and
// this untars it onto local disk.
//
// The mount stays the fallback: the daemon image and the API roll independently
// (1.55.14 and 1.55.15 pods were serving side by side while this was written),
// so a new daemon must survive an API that has no such route.

// Whole-set budget. One request, so the deadline covers the transfer rather
// than a per-file read; generous next to the 30s a single wedged file used to
// be allowed.
const skillTarTimeout = 60 * time.Second

// APIConfig is what the daemon needs to call org-fs over HTTP: the studio it was
// provisioned against, plus the fs-scoped token from ORGFS_CONFIG.
type APIConfig struct {
	BaseUrl string
	OrgSlug string
	Token   string
}

// SetAPIConfig records the org-fs endpoint from a relayed (or boot) config so
// the skill prefetch can bypass the mount. Safe to call repeatedly; the last
// config wins, matching the sidecar which remounts from it.
func (l *Links) SetAPIConfig(c APIConfig) {
	if l == nil || c.BaseUrl == "" || c.OrgSlug == "" || c.Token == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.api = &c
}

func (l *Links) apiConfig() *APIConfig {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.api
}

// fetchSkillTar streams a volume's skills into dir, naming each skill
// `<prefix><set>-<skill>`, and reports how many landed. A zero return means the
// caller should fall back to copying off the mount — including when the studio
// has no such route (older deployment) or the token is not accepted.
func (l *Links) fetchSkillTar(volume, set, dir string, budget *atomic.Int64) int {
	cfg := l.apiConfig()
	if cfg == nil {
		return 0
	}
	endpoint := fmt.Sprintf("%s/api/%s/fs/%s/skills.tar",
		strings.TrimRight(cfg.BaseUrl, "/"),
		url.PathEscape(cfg.OrgSlug), url.PathEscape(volume))

	ctx, cancel := context.WithTimeout(context.Background(), skillTarTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0
	}
	req.Header.Set("authorization", "Bearer "+cfg.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Warn("org-fs skill tar fetch failed", "volume", volume, "err", err)
		return 0
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		// 404 is the expected answer from a studio without this route, and from
		// a volume holding no skills. Either way: fall back, do not fail.
		slog.Warn("org-fs skill tar unavailable",
			"volume", volume, "status", res.StatusCode)
		return 0
	}
	n, err := extractSkillTar(res.Body, dir, publicSkillPrefix+set+"-", budget)
	if err != nil {
		slog.Warn("org-fs skill tar extract failed",
			"volume", volume, "landed", n, "err", err)
	}
	return n
}

// extractSkillTar writes a skills tar into dir, renaming each top-level skill
// folder to `<prefix><skill>`, and reports how many skills got at least one
// file. Bounded by budget; a truncated stream keeps whatever arrived whole.
func extractSkillTar(
	body io.Reader, dir, prefix string, budget *atomic.Int64,
) (int, error) {
	tr := tar.NewReader(body)
	seen := map[string]bool{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return len(seen), nil
		}
		if err != nil {
			return len(seen), err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		skill, rest, ok := splitSkillPath(h.Name)
		if !ok {
			slog.Warn("org-fs skill tar: refusing unsafe entry", "name", h.Name)
			continue
		}
		if budget.Add(-h.Size) < 0 {
			budget.Add(h.Size)
			return len(seen), fmt.Errorf("%w (at %s)", errSkillBudget, h.Name)
		}
		dst := filepath.Join(dir, prefix+skill, rest)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			budget.Add(h.Size)
			return len(seen), err
		}
		// Mode from the archive is advisory; the studio writes 0644 and the org
		// mount served 0755, so keep the exec bit skill helper scripts need.
		if err := writeFrom(tr, dst, os.FileMode(h.Mode).Perm()|0o111); err != nil {
			budget.Add(h.Size)
			return len(seen), err
		}
		seen[skill] = true
	}
}

// splitSkillPath validates a tar entry as `<skill>/<rest...>` and rejects
// anything that could escape the skills directory. Tar entry names are remote
// input: absolute paths, `..`, and backslashes are all refused rather than
// cleaned, because a cleaned path is a DIFFERENT file silently substituted.
func splitSkillPath(name string) (skill, rest string, ok bool) {
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, `\`) {
		return "", "", false
	}
	parts := strings.Split(name, "/")
	if len(parts) < 2 {
		return "", "", false
	}
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			return "", "", false
		}
	}
	if !safeSegment.MatchString(parts[0]) {
		return "", "", false
	}
	return parts[0], filepath.Join(parts[1:]...), true
}

func writeFrom(r io.Reader, dst string, perm os.FileMode) error {
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
