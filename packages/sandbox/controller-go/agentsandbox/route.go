package agentsandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"

	"github.com/decocms/studio/sandbox-controller/protocol"
)

// ssaFieldManager is retained verbatim from the TypeScript runner so Kubernetes
// keeps recognizing the fields owned by existing releases. Kubernetes tracks
// ownership per field by this string; changing it would make the first apply
// after cutover a conflict rather than a no-op.
const ssaFieldManager = "mesh-sandbox-runner"

var httpRouteGVR = schema.GroupVersionResource{
	Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes",
}

func (r *Runner) dyn() (dynamic.Interface, error) { return dynamic.NewForConfig(r.restConfig) }

// ensureServicePort applies port 9000 onto the operator-created Service.
//
// agent-sandbox v0.4.x ships per-Sandbox Services with an empty spec.ports —
// it assumes callers reach pods by pod-IP DNS. Nothing routes through a
// ports-less Service: kube-proxy programs no rule, and Istio's registry builds
// no upstream cluster, so an HTTPRoute backed by one is "Accepted" with
// nothing behind it (Envoy answers an empty 500, which the browser misreports
// as CORS).
//
// Gated on previewURLPattern alone, NOT on the gateway: that pattern is what
// decides studio reaches the daemon over Service DNS, and the Service needs a
// port for that whether or not a preview gateway exists. The TypeScript runner
// gated this on both because it only ever reached the daemon by port-forward,
// so the Service mattered for preview and nothing else.
//
// force=true so the FIRST apply takes ownership even though the operator set
// ports:[] under its own manager. Drop it and the apply 409s.
func (r *Runner) ensureServicePort(ctx context.Context, adoptedSandboxName string) error {
	if r.previewURLPattern == "" {
		return nil
	}
	body, err := json.Marshal(map[string]any{
		"apiVersion": "v1",
		"kind":       "Service",
		"metadata":   map[string]any{"name": adoptedSandboxName},
		"spec": map[string]any{
			"ports": []any{map[string]any{
				"name": "daemon", "port": daemonPort, "targetPort": daemonPort, "protocol": "TCP",
			}},
		},
	})
	if err != nil {
		return err
	}
	force := true
	_, err = r.core.CoreV1().Services(r.namespace).Patch(ctx, adoptedSandboxName,
		types.ApplyPatchType, body,
		metav1.PatchOptions{FieldManager: ssaFieldManager, Force: &force})
	if err != nil {
		return fmt.Errorf("failed to apply Service ports on %s: %w", adoptedSandboxName, err)
	}
	return nil
}

// ensureHTTPRoute upserts the per-claim route mapping <handle>.<base> to the
// adopted Sandbox's Service.
//
// Route name and hostname stay tied to the handle so the public preview URL is
// stable across pool re-adoptions; the backendRef points at adoptedSandboxName
// because that is the pod actually running the workload, not the cold-path
// orphan the v0.4.x adoption race sometimes leaves alongside it.
//
// Server-Side Apply makes this idempotent AND mutating: re-applying the same
// body is a no-op, re-applying a changed backendRef re-points it. The old
// create-and-swallow-409 path left backendRefs pinned to a deleted Service.
func (r *Runner) ensureHTTPRoute(ctx context.Context, handle, adoptedSandboxName string, opts *protocol.EnsureOptions) error {
	gw := r.cfg.PreviewGateway
	if gw == nil || r.previewURLPattern == "" {
		return nil
	}
	hostname := previewHostname(r.previewURLPattern, handle)
	if hostname == "" {
		return fmt.Errorf("unable to derive preview hostname for %s from pattern: %s", handle, r.previewURLPattern)
	}
	var tenant *protocol.Tenant
	if opts != nil {
		tenant = opts.Tenant
	}
	labels := tenantLabels(tenant, map[string]string{
		labelRole:                      "claimed",
		labelSandboxHandle:             handle,
		"app.kubernetes.io/name":       "studio-sandbox",
		"app.kubernetes.io/managed-by": "studio",
	})
	if r.envName != "" {
		labels[labelEnv] = r.envName
	}

	route := map[string]any{
		"apiVersion": "gateway.networking.k8s.io/v1",
		"kind":       "HTTPRoute",
		"metadata": map[string]any{
			"name": handle, "namespace": r.namespace, "labels": toAny(labels),
		},
		"spec": map[string]any{
			"parentRefs": []any{map[string]any{
				"kind": "Gateway", "group": "gateway.networking.k8s.io",
				"name": gw.Name, "namespace": gw.Namespace,
			}},
			"hostnames": []any{hostname},
			"rules": []any{map[string]any{
				"backendRefs": []any{map[string]any{
					"group": "", "kind": "Service",
					"name": adoptedSandboxName, "port": int64(daemonPort),
				}},
			}},
		},
	}
	body, err := json.Marshal(route)
	if err != nil {
		return err
	}
	client, err := r.dyn()
	if err != nil {
		return err
	}
	force := true
	_, err = client.Resource(httpRouteGVR).Namespace(r.namespace).Patch(ctx, handle,
		types.ApplyPatchType, body,
		metav1.PatchOptions{FieldManager: ssaFieldManager, Force: &force})
	if err != nil {
		return fmt.Errorf("failed to apply HTTPRoute %s: %w", handle, err)
	}
	return nil
}

func (r *Runner) deleteHTTPRoute(ctx context.Context, handle string) error {
	if r.cfg.PreviewGateway == nil {
		return nil
	}
	client, err := r.dyn()
	if err != nil {
		return err
	}
	err = client.Resource(httpRouteGVR).Namespace(r.namespace).Delete(ctx, handle, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

// previewHostname is the host half of the URL applyPreviewPattern produces —
// derived from the same function so the route and the link cannot disagree.
func previewHostname(pattern, handle string) string {
	full := applyPreviewPattern(pattern, handle)
	rest := full
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	if i := strings.IndexAny(rest, "/:"); i >= 0 {
		rest = rest[:i]
	}
	return rest
}

func toAny(m map[string]string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
