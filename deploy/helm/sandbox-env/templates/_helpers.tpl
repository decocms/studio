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
Mesh runner Role / RoleBinding name. Stays under 63 chars even with a
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
{{- if not (.Capabilities.APIVersions.Has "gateway.networking.k8s.io/v1") }}
{{- fail "sandbox-env: previewGateway.enabled=true requires the Gateway API CRDs (gateway.networking.k8s.io/v1). Install: kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/standard-install.yaml — and a Gateway controller (Istio, Envoy Gateway, Cilium, ...) implementing the chosen gatewayClassName." -}}
{{- end }}
{{- if not (.Capabilities.APIVersions.Has "cert-manager.io/v1") }}
{{- fail "sandbox-env: previewGateway.enabled=true requires cert-manager (cert-manager.io/v1). Install: helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true" -}}
{{- end }}
{{- end }}
{{- end }}

{{- define "sandbox-env.housekeeperName" -}}
{{- printf "sandbox-housekeeper-%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{/*
Default housekeeper selectors. Mirror the labels mesh stamps in runner.ts
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
`valueFrom.secretKeyRef`; mesh reads the same secret out-of-band (env var
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
{{- $existing := lookup "v1" "Secret" .Release.Namespace $name -}}
{{- if and $existing $existing.data $existing.data.daemonToken -}}
{{- $existing.data.daemonToken | b64dec -}}
{{- else -}}
{{- randAlphaNum 64 -}}
{{- end -}}
{{- end -}}
{{- end }}
