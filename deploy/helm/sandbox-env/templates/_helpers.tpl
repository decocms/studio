{{/*
Chart name (overridable via nameOverride).
*/}}
{{- define "sandbox-env.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Chart-name-and-version label.
*/}}
{{- define "sandbox-env.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
envName, validated. Required so multiple releases (dev / staging / prod)
can coexist in the shared `agent-sandbox-system` namespace without name
collisions; every other helper here suffixes with this value. Constrained
to RFC 1035 DNS labels (a-z0-9-, must start with a letter) so that the
suffixed resource names remain valid in every K8s context — Service /
Role / NetworkPolicy / Gateway names all share that constraint.
*/}}
{{- define "sandbox-env.envName" -}}
{{- $env := required "envName is required (e.g. envName=staging). Used as suffix on every resource name so multiple releases share agent-sandbox-system without collisions." .Values.envName -}}
{{- if not (regexMatch "^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$" $env) -}}
{{- fail (printf "envName=%q must be a DNS label: lowercase alphanumeric or '-', start with a letter, end alphanumeric, 1-32 chars" $env) -}}
{{- end -}}
{{- $env -}}
{{- end }}

{{/*
Sandbox-pod template + warm-pool name. Both share the same name because
the SandboxWarmPool references the SandboxTemplate by name, and dashboards
keying off `app.kubernetes.io/name` get a single coherent label.
*/}}
{{- define "sandbox-env.sandboxName" -}}
{{- printf "studio-sandbox-%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{/*
Validate daemonImpl before it selects an image. An unrecognised value would
otherwise fall through to the TS repository and quietly run the wrong daemon —
a canary that reads as "Go is fine" while never having run Go. A missing
goRepository would render `:<tag>` and fail as an ImagePullBackOff minutes later,
on the node, instead of here.
*/}}
{{- define "sandbox-env.validateDaemonImpl" -}}
{{- $impl := .Values.daemonImpl | default "ts" -}}
{{- if not (has $impl (list "ts" "go")) }}
{{- fail (printf "sandbox-env: daemonImpl must be \"ts\" or \"go\" (got %q)" $impl) -}}
{{- end }}
{{- if and (eq $impl "go") (not .Values.image.goRepository) }}
{{- fail "sandbox-env: daemonImpl=go requires image.goRepository (the studio-sandbox-go image). Set it, or leave daemonImpl=ts." -}}
{{- end }}
{{- end }}

{{/*
Sandbox container image, selected by daemonImpl. The daemon implementation is
the image — `studio-sandbox` runs the TS daemon, `studio-sandbox-go` the Go one
— so there is no runtime switch to disagree with. One tag drives both: they are
released together from the same source revision and must never skew.
*/}}
{{- define "sandbox-env.sandboxImage" -}}
{{- include "sandbox-env.validateDaemonImpl" . -}}
{{- $repo := .Values.image.repository -}}
{{- if eq (.Values.daemonImpl | default "ts") "go" -}}
{{- $repo = .Values.image.goRepository -}}
{{- end -}}
{{- printf "%s:%s" $repo (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end }}

{{/*
Studio runner Role / RoleBinding name. Stays under 63 chars even with a
32-char envName.
*/}}
{{- define "sandbox-env.runnerRoleName" -}}
{{- printf "studio-sandbox-runner-%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{/*
Preview Gateway / HTTPRoute / Certificate name.
*/}}
{{- define "sandbox-env.previewName" -}}
{{- printf "agent-sandbox-preview-%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{/*
Default cert-manager Secret name for the preview wildcard cert. Mirrors
the Gateway/HTTPRoute name so the cert ↔ listener pairing is obvious.
*/}}
{{- define "sandbox-env.previewTlsSecretName" -}}
{{- default (printf "agent-sandbox-preview-%s-tls" (include "sandbox-env.envName" .)) .Values.previewGateway.tlsSecretName -}}
{{- end }}

{{/*
Selector labels for sandbox pods. The runner stamps the same name label
onto every pod it creates via SandboxClaim.additionalPodMetadata, so the
NetworkPolicy podSelector can target it. Per-env, so two envs' netpols
don't accidentally apply to each other's pods.
*/}}
{{- define "sandbox-env.sandboxSelectorLabels" -}}
app.kubernetes.io/name: {{ include "sandbox-env.sandboxName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Common labels for sandbox-* resources. component=sandbox lets dashboards
split runtime sandbox pods from operator pods and traffic-edge resources.
*/}}
{{- define "sandbox-env.sandboxLabels" -}}
helm.sh/chart: {{ include "sandbox-env.chart" . }}
{{ include "sandbox-env.sandboxSelectorLabels" . }}
app.kubernetes.io/component: sandbox
studio.decocms.com/env: {{ include "sandbox-env.envName" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Common labels for the sandbox-preview Gateway/HTTPRoute/Certificate. Same
shape as sandboxLabels but with name=studio-sandbox-preview-<env> and
component=sandbox-preview so dashboards can split traffic-edge resources
from runtime sandbox pods.
*/}}
{{- define "sandbox-env.sandboxPreviewLabels" -}}
helm.sh/chart: {{ include "sandbox-env.chart" . }}
app.kubernetes.io/name: {{ include "sandbox-env.previewName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: sandbox-preview
studio.decocms.com/env: {{ include "sandbox-env.envName" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Common labels for non-sandbox resources owned by this chart (RBAC, etc.).
*/}}
{{- define "sandbox-env.labels" -}}
helm.sh/chart: {{ include "sandbox-env.chart" . }}
app.kubernetes.io/name: {{ include "sandbox-env.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
studio.decocms.com/env: {{ include "sandbox-env.envName" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Validate that Gateway API + cert-manager CRDs are present when the sandbox
preview gateway is enabled. Without this check, `helm install` would push
Gateway/HTTPRoute/Certificate to an API server that doesn't know those
kinds — the failure mode is an opaque "no matches for kind" rejection,
sometimes after partial-apply. Failing at template time keeps the release
atomic and gives a pointer to the right install command.
*/}}
{{- define "sandbox-env.validatePreviewGateway" -}}
{{- if .Values.previewGateway.enabled }}
{{- $tlsTermination := default "gateway" .Values.previewGateway.tlsTermination }}
{{- if not (or (eq $tlsTermination "gateway") (eq $tlsTermination "loadBalancer")) }}
{{- fail (printf "sandbox-env: previewGateway.tlsTermination must be \"gateway\" or \"loadBalancer\" (got %q)" $tlsTermination) -}}
{{- end }}
{{- if not (.Capabilities.APIVersions.Has "gateway.networking.k8s.io/v1") }}
{{- fail "sandbox-env: previewGateway.enabled=true requires the Gateway API CRDs (gateway.networking.k8s.io/v1). Install: kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/standard-install.yaml — and a Gateway controller (Istio, Envoy Gateway, Cilium, ...) implementing the chosen gatewayClassName." -}}
{{- end }}
{{/* cert-manager is only needed when Envoy terminates TLS. With
     tlsTermination=loadBalancer the cloud LB owns the cert, so cert-manager
     is not a prerequisite. */}}
{{- if ne .Values.previewGateway.tlsTermination "loadBalancer" }}
{{- if not (.Capabilities.APIVersions.Has "cert-manager.io/v1") }}
{{- fail "sandbox-env: previewGateway.enabled=true with tlsTermination=gateway requires cert-manager (cert-manager.io/v1). Install: helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true — or set previewGateway.tlsTermination=loadBalancer to terminate TLS at the cloud LB instead." -}}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Validate warmPool.autoscaling before rendering the HPA. Two failure modes
worth catching at template time rather than letting the API server reject
(or silently no-op) them:
  - autoscaling.enabled with warmPool.enabled=false: there's no
    SandboxWarmPool object for the HPA to target.
  - autoscaling.enabled with an empty metrics list: an HPA with no metrics
    can't compute a desired replica count, so it would just sit idle at
    minReplicas forever — this chart ships no default metric (see
    sandbox-warmpool-hpa.yaml), so the operator must supply one.
*/}}
{{- define "sandbox-env.validateWarmPoolAutoscaling" -}}
{{- if .Values.warmPool.autoscaling.enabled }}
{{- if not .Values.warmPool.enabled }}
{{- fail "sandbox-env: warmPool.autoscaling.enabled=true requires warmPool.enabled=true (there's no SandboxWarmPool to scale otherwise)." -}}
{{- end }}
{{- if eq (len .Values.warmPool.autoscaling.metrics) 0 }}
{{- fail "sandbox-env: warmPool.autoscaling.enabled=true requires at least one entry in warmPool.autoscaling.metrics — this chart ships no default metric. See values.yaml for an example External-metric entry." -}}
{{- end }}
{{- end }}
{{- end }}

{{- define "sandbox-env.housekeeperName" -}}
{{- printf "sandbox-housekeeper-%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{/*
Default housekeeper selectors. Mirror the labels Studio stamps in runner.ts
(`studio.decocms.com/env=<envName>` requires STUDIO_ENV); during phased
rollout, .Values.housekeeper.{claimSelector,podSelector} can be overridden
to drop the env scope. README has copy-paste values.
*/}}
{{- define "sandbox-env.housekeeperClaimSelector" -}}
{{- printf "app.kubernetes.io/managed-by=studio,app.kubernetes.io/name=studio-sandbox,studio.decocms.com/env=%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{- define "sandbox-env.housekeeperPodSelector" -}}
{{- printf "studio.decocms.com/role=claimed,studio.decocms.com/env=%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{/*
Sentinel-token Secret name. Holds the bearer baked into pool-pod env via
`valueFrom.secretKeyRef`; Studio reads the same secret out-of-band (env var
sourced from this Secret in the studio chart) so both sides agree on the
sentinel without it landing in any chart values.yaml.
*/}}
{{- define "sandbox-env.sentinelSecretName" -}}
{{- printf "studio-sandbox-sentinel-%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{/*
Sentinel token. Priority order:
  1. .Values.sentinel.token — explicit value supplied by CI/operator so
     both charts (sandbox-env + studio) can be deployed with the same token
     without an extraction step.
  2. Existing Secret — preserves the token across `helm upgrade` so
     rotating is an explicit opt-in (delete the Secret + re-upgrade).
  3. randAlphaNum 64 — generated on first install when neither of the
     above is present.
*/}}
{{- define "sandbox-env.sentinelToken" -}}
{{- if and .Values.sentinel .Values.sentinel.token (ne .Values.sentinel.token "") -}}
{{- .Values.sentinel.token -}}
{{- else -}}
{{- $name := include "sandbox-env.sentinelSecretName" . -}}
{{- /* Look up in agent-sandbox-system — where the Secret is actually created
       (see sandbox-sentinel-secret.yaml) — so the token is preserved across
       `helm upgrade` even when the release namespace differs (e.g. umbrella). */ -}}
{{- $existing := lookup "v1" "Secret" "agent-sandbox-system" $name -}}
{{- if and $existing $existing.data $existing.data.daemonToken -}}
{{- $existing.data.daemonToken | b64dec -}}
{{- else -}}
{{- randAlphaNum 64 -}}
{{- end -}}
{{- end -}}
{{- end }}
