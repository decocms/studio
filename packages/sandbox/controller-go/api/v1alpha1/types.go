// Package v1alpha1 is the SandboxVariant API: the one contract the chart,
// kubectl and the control plane's agent write, and the controller reads.
//
// +kubebuilder:object:generate=true
// +groupName=sandbox.deco.cx
package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	GroupVersion  = schema.GroupVersion{Group: "sandbox.deco.cx", Version: "v1alpha1"}
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}
	AddToScheme   = SchemeBuilder.AddToScheme
)

func init() {
	SchemeBuilder.Register(&SandboxVariant{}, &SandboxVariantList{})
}

// SandboxVariant says "this cluster offers variant <v> of template <base>".
// Its name IS the rendered template's name, `<baseTemplate>-<v>`: stg and prod
// templates share one namespace and differ only by base, so a bare `<v>` name
// would collide across environments.
//
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=sv
// +kubebuilder:printcolumn:name="Base",type=string,JSONPath=`.spec.baseTemplate`
// +kubebuilder:printcolumn:name="Tag",type=string,JSONPath=`.spec.image.tag`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:validation:XValidation:rule="self.metadata.name.startsWith(self.spec.baseTemplate + '-')",message="metadata.name must be <spec.baseTemplate>-<variant>"
// +kubebuilder:validation:XValidation:rule="!self.metadata.name.startsWith(self.spec.baseTemplate + '-') || self.metadata.name.substring(size(self.spec.baseTemplate) + 1).matches('^[a-z][a-z0-9-]{0,31}$')",message="the variant (metadata.name after <spec.baseTemplate>-) must match ^[a-z][a-z0-9-]{0,31}$"
// +kubebuilder:validation:XValidation:rule="!(self.metadata.name.endsWith('-medium'))",message="a variant may not end in -medium: <base>-<v>-medium is its own medium template"
type SandboxVariant struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   SandboxVariantSpec   `json:"spec"`
	Status SandboxVariantStatus `json:"status,omitempty"`
}

type SandboxVariantSpec struct {
	// The default SandboxTemplate this variant is copied from. Its `-medium`
	// sibling is the base of the variant's medium template.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=200
	BaseTemplate string `json:"baseTemplate"`

	Image Image `json:"image"`

	// The base image tag the variant was built FROM, so skew against
	// status.defaultTemplateTag is readable from the object.
	// +kubebuilder:validation:MinLength=1
	BaseTag string `json:"baseTag"`

	// Replace the base template's, when set.
	// +optional
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`
	// +optional
	Tolerations []corev1.Toleration `json:"tolerations,omitempty"`

	// Deep-merged over each size's own `sandbox` container resources.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// emptyDir sizeLimits by volume name, merged over the base template's.
	// +optional
	VolumeSizes map[string]resource.Quantity `json:"volumeSizes,omitempty"`

	// +optional
	WarmPool WarmPool `json:"warmPool,omitempty"`
}

type Image struct {
	// +kubebuilder:validation:MinLength=1
	Repository string `json:"repository"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:XValidation:rule="self != 'latest'",message="pin a tag; latest cannot be checked or rolled back"
	Tag string `json:"tag"`
}

type WarmPool struct {
	// +kubebuilder:validation:Minimum=0
	// +optional
	Size int32 `json:"size,omitempty"`
	// +kubebuilder:validation:Minimum=0
	// +optional
	MediumSize int32 `json:"mediumSize,omitempty"`
}

const (
	// ImageAvailable: a registry HEAD found spec.image.
	ConditionImageAvailable = "ImageAvailable"
	// Rendered: the four objects match the current spec and base templates.
	ConditionRendered = "Rendered"
	// Ready: the templates exist and a claim can use them — possibly from a
	// previous render, when Rendered is False.
	ConditionReady = "Ready"
)

type SandboxVariantStatus struct {
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
	// The base template's sandbox image tag.
	// +optional
	DefaultTemplateTag string `json:"defaultTemplateTag,omitempty"`
	// +optional
	Templates []string `json:"templates,omitempty"`
}

// +kubebuilder:object:root=true
type SandboxVariantList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []SandboxVariant `json:"items"`
}

// Variant is the name Studio stores in repositories.sandbox_image.
func (v *SandboxVariant) Variant() string {
	return v.Name[len(v.Spec.BaseTemplate)+1:]
}

var _ runtime.Object = &SandboxVariant{}
