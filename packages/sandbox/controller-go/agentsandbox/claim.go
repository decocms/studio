package agentsandbox

import (
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/decocms/studio/packages/sandbox/controller-go/daemonclient"
	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

// Label and annotation keys, verbatim from the in-process runner: the chart's
// housekeeper and dashboards select on them.
const (
	labelRole          = "studio.decocms.com/role"
	labelSandboxHandle = "studio.decocms.com/sandbox-handle"
	labelOrgID         = "studio.decocms.com/org-id"
	labelUserID        = "studio.decocms.com/user-id"
	labelEnv           = "studio.decocms.com/env"

	annOrgSlug    = "studio.decocms.com/org-slug"
	annOrgName    = "studio.decocms.com/org-name"
	annUserEmail  = "studio.decocms.com/user-email"
	annUserName   = "studio.decocms.com/user-name"
	annGitRepo    = "studio.decocms.com/git-repo"
	annGitRepoURL = "studio.decocms.com/git-repo-url"
	annGitBranch  = "studio.decocms.com/git-branch"
)

type bootSecrets struct {
	token        string
	daemonBootID string
	workdir      string
}

var labelValue = regexp.MustCompile(`^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$`)

// sanitizeLabelValue drops a value Kubernetes would reject, which would fail
// the whole claim.
func sanitizeLabelValue(v string) string {
	if len(v) > 63 {
		v = v[:63]
	}
	if !labelValue.MatchString(v) {
		return ""
	}
	return v
}

func tenantLabels(t *protocol.Tenant, extra map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range extra {
		out[k] = v
	}
	if t != nil {
		if v := sanitizeLabelValue(t.OrgID); v != "" {
			out[labelOrgID] = v
		}
		if v := sanitizeLabelValue(t.UserID); v != "" {
			out[labelUserID] = v
		}
	}
	return out
}

func sanitizeAnnotationValue(v string) string {
	var b strings.Builder
	for _, r := range v {
		if r < 0x20 || r == 0x7f {
			b.WriteRune(' ')
		} else {
			b.WriteRune(r)
		}
	}
	out := []rune(b.String())
	if len(out) > 253 {
		out = out[:253]
	}
	return string(out)
}

// tenantAnnotations is human-readable ownership for `kubectl describe`.
// Informational only.
func tenantAnnotations(opts protocol.EnsureOptions) map[string]string {
	out := map[string]string{}
	put := func(k, v string) {
		if v != "" {
			out[k] = sanitizeAnnotationValue(v)
		}
	}
	if t := opts.Tenant; t != nil {
		put(annOrgSlug, t.OrgSlug)
		put(annOrgName, t.OrgName)
		put(annUserEmail, t.UserEmail)
		put(annUserName, t.UserName)
	}
	if r := opts.Repo; r != nil {
		put(annGitRepo, r.DisplayName)
		put(annGitRepoURL, daemonclient.StripURLCredentials(r.CloneURL))
		// The synthetic isolation key reads better than repo.branch, the
		// derived git ref.
		branch := opts.Branch
		if branch == "" {
			branch = r.Branch
		}
		put(annGitBranch, branch)
	}
	return out
}

// readClaimTenant recovers the tenant from a claim's labels, for adopt.
func readClaimTenant(c *Claim) *protocol.Tenant {
	org, user := c.Labels[labelOrgID], c.Labels[labelUserID]
	if org == "" || user == "" {
		return nil
	}
	return &protocol.Tenant{
		OrgID: org, UserID: user,
		OrgSlug: c.Annotations[annOrgSlug], OrgName: c.Annotations[annOrgName],
		UserEmail: c.Annotations[annUserEmail], UserName: c.Annotations[annUserName],
	}
}

type claimInput struct {
	handle    string
	namespace string
	envName   string
	opts      protocol.EnsureOptions
	boot      bootSecrets
	template  string
	warmPool  string
	// warm: warm-pool mode, where the per-claim token arrives post-bind by
	// rotation and spec.env must stay empty.
	warm     bool
	shutdown time.Time
}

// buildClaim renders the SandboxClaim.
func buildClaim(in claimInput) (*Claim, []string) {
	var env []EnvVar
	var dropped []string
	if !in.warm {
		m, d := daemonclient.BootEnv(in.opts.Env, in.boot.token, in.boot.daemonBootID, in.boot.workdir)
		dropped = d
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		// Sorted so `kubectl diff` does not churn across equal env.
		sort.Strings(keys)
		for _, k := range keys {
			env = append(env, EnvVar{Name: k, Value: m[k]})
		}
	}
	labels := tenantLabels(in.opts.Tenant, map[string]string{
		"app.kubernetes.io/name":       "studio-sandbox",
		"app.kubernetes.io/managed-by": "studio",
	})
	podLabels := tenantLabels(in.opts.Tenant, map[string]string{
		labelRole:          "claimed",
		labelSandboxHandle: in.handle,
	})
	if in.envName != "" {
		labels[labelEnv] = in.envName
		podLabels[labelEnv] = in.envName
	}
	annotations := tenantAnnotations(in.opts)
	shutdown := metav1.NewTime(in.shutdown)
	c := &Claim{
		TypeMeta: metav1.TypeMeta{APIVersion: claimAPIVersion, Kind: claimKind},
		ObjectMeta: metav1.ObjectMeta{
			Name:      in.handle,
			Namespace: in.namespace,
			// Tenant on the claim too, so adopt recovers it after a store wipe.
			Labels: labels,
		},
		Spec: ClaimSpec{
			TemplateRef:           TemplateRef{Name: in.template},
			AdditionalPodMetadata: PodMetadata{Labels: podLabels},
			Env:                   env,
			WarmPool:              in.warmPool,
			Lifecycle:             &Lifecycle{ShutdownPolicy: "Delete", ShutdownTime: &shutdown},
		},
	}
	if len(annotations) > 0 {
		c.Annotations = annotations
		c.Spec.AdditionalPodMetadata.Annotations = annotations
	}
	return c, dropped
}

var envNamePattern = regexp.MustCompile(`^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$`)

// ValidEnvName matches the chart's envName rule: it names Kubernetes objects.
func ValidEnvName(s string) bool { return s == "" || envNamePattern.MatchString(s) }

// applyPreviewPattern: `{handle}` substitutes, otherwise the handle prefixes
// the hostname. Trailing slash normalized.
func applyPreviewPattern(pattern, handle string) string {
	base := strings.TrimRight(pattern, "/")
	if strings.Contains(base, "{handle}") {
		return strings.Replace(base, "{handle}", handle, 1) + "/"
	}
	if u, err := url.Parse(base); err == nil && u.Scheme != "" && u.Host != "" {
		u.Host = handle + "." + u.Host
		return u.String() + "/"
	}
	return base + "/" + handle + "/"
}

// previewHostname is the host of the URL applyPreviewPattern builds, so the
// route and the link cannot disagree.
func previewHostname(pattern, handle string) string {
	u, err := url.Parse(applyPreviewPattern(pattern, handle))
	if err != nil {
		return ""
	}
	return u.Hostname()
}
