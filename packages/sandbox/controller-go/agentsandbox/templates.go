package agentsandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

// templateProbeTTL is how long a derived template's lookup is trusted, both
// ways, so a chart upgrade or rollback is picked up without a GET per claim.
const templateProbeTTL = 5 * time.Minute

const mediumSuffix = "-medium"

// claimTemplateName is `<base>[-<image>][-medium]`: a claim can override
// neither image nor resources, so each combination is its own template. A
// harness run takes the roomier -medium; so does a tenant-pool claim, because
// the chart builds tenant pools from -medium and the operator binds warm pods
// by template.
func claimTemplateName(purpose protocol.Purpose, base string, tenantPool *TenantPool, image string) string {
	name := base
	if !isDefaultImage(image) {
		name += "-" + image
	}
	if purpose == protocol.PurposeHarnessRun || tenantPool != nil {
		name += mediumSuffix
	}
	return name
}

func isDefaultImage(image string) bool { return image == "" || image == "default" }

type templateProbe struct {
	checkedAt time.Time
	present   bool
}

// templateResolver degrades a derived template the cluster lacks: first
// without the image, then to the base. Studio and the chart deploy
// independently, and a claim naming a missing template parks at
// TemplateNotFound until its wait fails.
type templateResolver struct {
	base   string
	exists func(ctx context.Context, name string) (bool, error)
	now    func() time.Time
	// onAbsent reports a derived template going missing; a warning by default.
	onAbsent func(name string)

	mu     sync.Mutex
	probes map[string]templateProbe
}

type resolvedTemplate struct {
	name string
	// image actually served: "default" when the variant fell away.
	image string
}

func (t *templateResolver) resolve(ctx context.Context, purpose protocol.Purpose, pool *TenantPool, image string) (resolvedTemplate, error) {
	served := image
	if isDefaultImage(served) {
		served = "default"
	}
	wanted := claimTemplateName(purpose, t.base, pool, image)
	if wanted == t.base {
		return resolvedTemplate{name: wanted, image: served}, nil
	}
	t.mu.Lock()
	cached, hit := t.probes[wanted]
	t.mu.Unlock()
	probe := cached
	if !hit || t.now().Sub(cached.checkedAt) >= templateProbeTTL {
		present, err := t.exists(ctx, wanted)
		if err != nil {
			return resolvedTemplate{}, err
		}
		probe = templateProbe{checkedAt: t.now(), present: present}
		t.mu.Lock()
		t.probes[wanted] = probe
		t.mu.Unlock()
	}
	if probe.present {
		return resolvedTemplate{name: wanted, image: served}, nil
	}
	// Warn once per absence, not once per claim.
	if !hit || cached.present {
		if t.onAbsent != nil {
			t.onAbsent(wanted)
		} else {
			slog.Warn("SandboxTemplate not found (or not readable); claims fall back to a template without that suffix", "template", wanted)
		}
	}
	// Drop the image before the size: a missing variant must not also cost a
	// harness run its -medium memory ceiling.
	if !isDefaultImage(image) {
		return t.resolve(ctx, purpose, pool, "")
	}
	return resolvedTemplate{name: t.base, image: served}, nil
}

// TenantPool is one org's warm pool of pods already running its repo's dev
// server. Config shape and rules from STUDIO_SANDBOX_TENANT_POOLS.
type TenantPool struct {
	// SandboxWarmPool name, rendered by the chart from the same string.
	Name string `json:"name"`
	// The only org whose members may be given one of these pods.
	OrgID string `json:"orgId"`
	// `owner/name` on github.com, case-insensitive.
	Repo         string        `json:"repo"`
	ConnectionID string        `json:"connectionId,omitempty"`
	Branch       string        `json:"branch,omitempty"`
	Workload     *PoolWorkload `json:"workload,omitempty"`
}

type PoolWorkload struct {
	Runtime            string `json:"runtime,omitempty"`
	PackageManager     string `json:"packageManager,omitempty"`
	PackageManagerPath string `json:"packageManagerPath,omitempty"`
	DevPort            int    `json:"devPort,omitempty"`
}

var (
	poolNamePattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	poolRepoPattern = regexp.MustCompile(`^[^/\s]+/[^/\s]+$`)
)

// ParseTenantPools reads STUDIO_SANDBOX_TENANT_POOLS. Malformed config is an
// error: a pool that silently fails to parse costs N pods and serves nobody.
func ParseTenantPools(raw string) ([]TenantPool, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var pools []TenantPool
	if err := json.Unmarshal([]byte(raw), &pools); err != nil {
		return nil, fmt.Errorf("tenant pools: %w", err)
	}
	seen := map[string]bool{}
	for i := range pools {
		p := &pools[i]
		switch {
		case !poolNamePattern.MatchString(p.Name):
			return nil, fmt.Errorf("tenant pools: name %q must be a DNS label", p.Name)
		case p.OrgID == "":
			return nil, fmt.Errorf("tenant pools: %s has no orgId", p.Name)
		case !poolRepoPattern.MatchString(p.Repo):
			return nil, fmt.Errorf("tenant pools: %s repo %q must be owner/name", p.Name, p.Repo)
		case seen[p.Name]:
			return nil, fmt.Errorf("tenant pools: duplicate pool name %s", p.Name)
		}
		seen[p.Name] = true
		if p.Branch == "" {
			p.Branch = "main"
		}
		if p.Workload == nil {
			p.Workload = &PoolWorkload{}
		}
		if p.Workload.Runtime == "" {
			p.Workload.Runtime = "node"
		}
	}
	return pools, nil
}

// repoKeyFromCloneURL is `owner/name`, lowercased, for a github.com URL only:
// a GitLab `acme/site` must never bind a pool warmed for GitHub's.
func repoKeyFromCloneURL(cloneURL string) string {
	u, err := url.Parse(cloneURL)
	if err != nil || !strings.EqualFold(u.Hostname(), "github.com") {
		return ""
	}
	parts := strings.Split(strings.TrimLeft(u.Path, "/"), "/")
	if len(parts) < 2 {
		return ""
	}
	owner, name := parts[0], strings.TrimSuffix(parts[1], ".git")
	if owner == "" || name == "" {
		return ""
	}
	return strings.ToLower(owner + "/" + name)
}

// resolveTenantPool is the isolation boundary: orgID is the org of the user
// being served, and the operator binds whatever pool a claim names. A
// non-default image never resolves one: pools are built from the default
// image's template.
func resolveTenantPool(pools []TenantPool, opts protocol.EnsureOptions) *TenantPool {
	if !isDefaultImage(opts.SandboxImage) || opts.Tenant == nil || opts.Tenant.OrgID == "" || opts.Repo == nil {
		return nil
	}
	key := repoKeyFromCloneURL(opts.Repo.CloneURL)
	if key == "" {
		return nil
	}
	for i := range pools {
		if pools[i].OrgID == opts.Tenant.OrgID && strings.ToLower(pools[i].Repo) == key {
			return &pools[i]
		}
	}
	return nil
}

// claimWarmPool is spec.warmpool. A tenant pool binds one of that org's pods;
// otherwise the generic pool, NAMED: the chart names it after its template.
// "default" would let the operator take any pool built from the template,
// tenant pools included, and hand one org's prewarmed pod to another's claim.
// Without a sentinel, "none": the operator rejects per-claim env otherwise.
func claimWarmPool(pool *TenantPool, warm bool, template string) string {
	switch {
	case pool != nil:
		return pool.Name
	case warm:
		return template
	default:
		return warmPoolNone
	}
}
