// Package agentsandbox is the Kubernetes runtime: SandboxClaims against the
// agent-sandbox operator (v1alpha1, as operator 0.4.5 serves it), the port of
// Studio's in-process runner.
package agentsandbox

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// The operator's resources, read and written as JSON through the dynamic
// client. Local types rather than the operator's module: it requires a newer Go
// than this module, and the runtime touches a handful of fields.
var (
	ClaimGVR     = schema.GroupVersionResource{Group: "extensions.agents.x-k8s.io", Version: "v1alpha1", Resource: "sandboxclaims"}
	TemplateGVR  = schema.GroupVersionResource{Group: "extensions.agents.x-k8s.io", Version: "v1alpha1", Resource: "sandboxtemplates"}
	HTTPRouteGVR = schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"}
)

const (
	claimAPIVersion = "extensions.agents.x-k8s.io/v1alpha1"
	claimKind       = "SandboxClaim"
	// warmPoolNone forces a fresh pod: the operator rejects per-claim env
	// from any other policy.
	warmPoolNone = "none"
)

// Claim is the slice of extensions.agents.x-k8s.io/v1alpha1 SandboxClaim the
// runtime reads and writes.
type Claim struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              ClaimSpec   `json:"spec"`
	Status            ClaimStatus `json:"status,omitempty"`
}

type ClaimSpec struct {
	TemplateRef           TemplateRef `json:"sandboxTemplateRef"`
	AdditionalPodMetadata PodMetadata `json:"additionalPodMetadata,omitempty"`
	Env                   []EnvVar    `json:"env,omitempty"`
	// "none", "default" (any pool built from the template), or a pool name.
	WarmPool  string     `json:"warmpool,omitempty"`
	Lifecycle *Lifecycle `json:"lifecycle,omitempty"`
}

type TemplateRef struct {
	Name string `json:"name"`
}

type PodMetadata struct {
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type Lifecycle struct {
	ShutdownPolicy string       `json:"shutdownPolicy,omitempty"`
	ShutdownTime   *metav1.Time `json:"shutdownTime,omitempty"`
}

type ClaimStatus struct {
	Conditions []metav1.Condition `json:"conditions,omitempty"`
	// Sandbox is the Sandbox the operator bound. Equal to the claim name on a
	// cold start; a pool pod's generated name on warm-pool adoption.
	Sandbox struct {
		Name string `json:"name,omitempty"`
	} `json:"sandbox,omitempty"`
}

func (c *Claim) ready() bool {
	for _, cond := range c.Status.Conditions {
		if cond.Type == "Ready" && cond.Status == metav1.ConditionTrue {
			return true
		}
	}
	return false
}

func (c *Claim) env(name string) string {
	for _, e := range c.Spec.Env {
		if e.Name == name {
			return e.Value
		}
	}
	return ""
}
