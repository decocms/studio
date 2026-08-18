package agentsandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/watch"
	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	extv1alpha1 "sigs.k8s.io/agent-sandbox/extensions/api/v1alpha1"

	"github.com/decocms/studio/sandbox-controller/protocol"
)

// Label and annotation keys, verbatim from the TypeScript runner. Labels are
// charset-restricted so they carry IDs only; annotations carry the identity
// that cannot be a label (emails with @, org names with spaces, repo paths).
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

	// podNameAnnotation is what the operator writes on the Sandbox.
	podNameAnnotation = "agents.x-k8s.io/pod-name"
	// mainContainer is the agent container; siblings are the org-fs sidecar
	// and the init containers.
	mainContainer = "sandbox"
)

func tenantLabels(t *protocol.Tenant, extra map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range extra {
		out[k] = v
	}
	if t != nil {
		if t.OrgID != "" {
			out[labelOrgID] = t.OrgID
		}
		if t.UserID != "" {
			out[labelUserID] = t.UserID
		}
	}
	return out
}

// tenantAnnotations is human-readable ownership carried on both the claim and
// the pod, so `kubectl describe` answers "whose sandbox is this" without a
// join back to studio's database. Purely informational.
func tenantAnnotations(opts *protocol.EnsureOptions) map[string]string {
	out := map[string]string{}
	if opts == nil {
		return out
	}
	if t := opts.Tenant; t != nil {
		put(out, annOrgSlug, t.OrgSlug)
		put(out, annOrgName, t.OrgName)
		put(out, annUserEmail, t.UserEmail)
		put(out, annUserName, t.UserName)
	}
	if r := opts.Repo; r != nil {
		put(out, annGitRepo, r.DisplayName)
		put(out, annGitRepoURL, redactCloneURL(r.CloneURL))
	}
	// Prefer opts.Branch: repo.Branch is the real git ref the daemon checks
	// out, which for thread-scoped work is a derived name rather than the
	// isolation key an operator wants to read here.
	if opts.Branch != "" {
		put(out, annGitBranch, opts.Branch)
	} else if opts.Repo != nil {
		put(out, annGitBranch, opts.Repo.Branch)
	}
	return out
}

func put(m map[string]string, k, v string) {
	if strings.TrimSpace(v) != "" {
		m[k] = v
	}
}

// redactCloneURL strips any embedded credential before the URL is written to a
// cluster object every co-tenant operator can read. Fails closed: an
// unparseable URL annotates nothing rather than falling through to the raw
// string.
func redactCloneURL(raw string) string {
	if raw == "" {
		return ""
	}
	at := strings.LastIndex(raw, "@")
	scheme := strings.Index(raw, "://")
	if scheme < 0 {
		return ""
	}
	if at < 0 {
		return raw
	}
	return raw[:scheme+3] + raw[at+1:]
}

// buildClaim renders the SandboxClaim. In warm-pool mode spec.env stays empty:
// the operator rejects per-claim env when warmpool != "none", so the per-claim
// secret is delivered post-bind via POST /_sandbox/config + auth.rotateToken.
func (r *Runner) buildClaim(handle string, opts *protocol.EnsureOptions, boot bootSecrets, templateName string) *extv1alpha1.SandboxClaim {
	warmPoolMode := r.sentinelToken != ""

	var env []extv1alpha1.EnvVar
	if !warmPoolMode {
		env = sortedEnv(r.envMap(opts, boot))
	}

	annotations := tenantAnnotations(opts)
	var tenant *protocol.Tenant
	if opts != nil {
		tenant = opts.Tenant
	}

	labels := tenantLabels(tenant, map[string]string{
		"app.kubernetes.io/name":       "studio-sandbox",
		"app.kubernetes.io/managed-by": "studio",
	})
	if r.envName != "" {
		labels[labelEnv] = r.envName
	}

	podLabels := tenantLabels(tenant, map[string]string{
		labelRole:          "claimed",
		labelSandboxHandle: handle,
	})
	if r.envName != "" {
		podLabels[labelEnv] = r.envName
	}

	warmPool := extv1alpha1.WarmPoolPolicyNone
	if warmPoolMode {
		warmPool = extv1alpha1.WarmPoolPolicyDefault
	}
	shutdown := metav1.NewTime(time.Now().Add(r.idleTTL))

	claim := &extv1alpha1.SandboxClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      handle,
			Namespace: r.namespace,
			// Tenant is duplicated onto the claim, not just the pod, so adopt
			// can recover orgId/userId after a state-store wipe.
			Labels: labels,
		},
		Spec: extv1alpha1.SandboxClaimSpec{
			TemplateRef: extv1alpha1.SandboxTemplateRef{Name: templateName},
			AdditionalPodMetadata: sandboxv1alpha1.PodMetadata{
				Labels: podLabels,
			},
			Env:      env,
			WarmPool: &warmPool,
			Lifecycle: &extv1alpha1.Lifecycle{
				ShutdownPolicy: extv1alpha1.ShutdownPolicyDelete,
				ShutdownTime:   &shutdown,
			},
		},
	}
	if len(annotations) > 0 {
		claim.ObjectMeta.Annotations = annotations
		claim.Spec.AdditionalPodMetadata.Annotations = annotations
	}
	return claim
}

func (r *Runner) getClaim(ctx context.Context, handle string) (*extv1alpha1.SandboxClaim, error) {
	claim, err := r.claims().Get(ctx, handle, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	return claim, err
}

func (r *Runner) deleteClaim(ctx context.Context, handle string) error {
	err := r.claims().Delete(ctx, handle, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

// waitForClaimGone polls until the API server has GC'd the resource. The
// operator's idle TTL deletes the claim, but pod teardown and finalizers take
// seconds; recreating inside that window 409s.
func (r *Runner) waitForClaimGone(ctx context.Context, handle string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		claim, err := r.getClaim(ctx, handle)
		if err != nil {
			return err
		}
		if claim == nil {
			return nil
		}
		if time.Now().After(deadline) {
			// A stuck finalizer is the plausible non-recoverable cause, and
			// naming it distinguishes "operator is slow" from "operator
			// dropped the claim on the floor".
			return fmt.Errorf("SandboxClaim %s still present after %s (deletionTimestamp=%v finalizers=%v)",
				handle, timeout, claim.DeletionTimestamp, claim.Finalizers)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// waitForAdoptedSandbox waits for the operator to write status.sandbox.name.
//
// Two-step bind resolution is deliberate. Watching by metadata.name=<handle>
// would work for cold starts (the operator names cold Sandboxes after the
// claim) but warm-pool adoption binds a pre-existing pool name instead — and
// the v0.4.x status-update race occasionally also creates a stray same-named
// cold Sandbox alongside it. status.sandbox.name is the only signal that
// points at the pod actually running the workload.
func (r *Runner) waitForAdoptedSandbox(ctx context.Context, handle string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	claim, err := r.getClaim(ctx, handle)
	if err != nil {
		return "", err
	}
	if claim != nil && claim.Status.SandboxStatus.Name != "" {
		return claim.Status.SandboxStatus.Name, nil
	}

	w, err := r.claims().Watch(ctx, metav1.ListOptions{FieldSelector: "metadata.name=" + handle})
	if err != nil {
		return "", err
	}
	defer w.Stop()
	for {
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("timed out waiting for SandboxClaim %s to bind a Sandbox", handle)
		case ev, ok := <-w.ResultChan():
			if !ok {
				return "", fmt.Errorf("watch on SandboxClaim %s closed before it bound", handle)
			}
			if ev.Type == watch.Error {
				return "", fmt.Errorf("watch error on SandboxClaim %s", handle)
			}
			c, ok := ev.Object.(*extv1alpha1.SandboxClaim)
			if ok && c.Status.SandboxStatus.Name != "" {
				return c.Status.SandboxStatus.Name, nil
			}
		}
	}
}

// waitForSandboxReady resolves on the first Ready=True condition on the bound
// Sandbox.
func (r *Runner) waitForSandboxReady(ctx context.Context, name string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if ready, err := r.sandboxReady(ctx, name); err != nil {
		return err
	} else if ready {
		return nil
	}

	w, err := r.sandboxes().Watch(ctx, metav1.ListOptions{FieldSelector: "metadata.name=" + name})
	if err != nil {
		return err
	}
	defer w.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("timed out waiting for Sandbox %s to become Ready", name)
		case ev, ok := <-w.ResultChan():
			if !ok {
				return fmt.Errorf("watch on Sandbox %s closed before Ready", name)
			}
			sb, ok := ev.Object.(*sandboxv1alpha1.Sandbox)
			if !ok {
				continue
			}
			if conditionTrue(sb.Status.Conditions, "Ready") {
				return nil
			}
		}
	}
}

func (r *Runner) sandboxReady(ctx context.Context, name string) (bool, error) {
	sb, err := r.sandboxes().Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return conditionTrue(sb.Status.Conditions, "Ready"), nil
}

func conditionTrue(conds []metav1.Condition, kind string) bool {
	for _, c := range conds {
		if c.Type == kind && c.Status == metav1.ConditionTrue {
			return true
		}
	}
	return false
}

// patchShutdown moves the claim's shutdown time. Merge-patch rather than SSA:
// this touches one field the operator does not otherwise own.
func (r *Runner) patchShutdown(ctx context.Context, handle string, at time.Time) error {
	body, err := json.Marshal(map[string]any{
		"spec": map[string]any{
			"lifecycle": map[string]any{
				"shutdownTime": at.UTC().Format(time.RFC3339),
			},
		},
	})
	if err != nil {
		return err
	}
	_, err = r.claims().Patch(ctx, handle, types.MergePatchType, body, metav1.PatchOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

func sortedEnv(m map[string]string) []extv1alpha1.EnvVar {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Sorted so `kubectl diff` does not churn across runs that pass the same
	// env in a different insertion order.
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	out := make([]extv1alpha1.EnvVar, 0, len(keys))
	for _, k := range keys {
		out = append(out, extv1alpha1.EnvVar{Name: k, Value: m[k]})
	}
	return out
}
