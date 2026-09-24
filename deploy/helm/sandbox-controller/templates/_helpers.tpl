{{/*
One release per environment sharing a sandbox namespace, so every object is
named after the release. A release whose name contains the chart name (the
default "sandbox-controller") keeps that name as is.
*/}}
{{- define "sandbox-controller.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{- define "sandbox-controller.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: sandbox-controller
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "sandbox-controller.selectorLabels" -}}
app.kubernetes.io/name: sandbox-controller
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "sandbox-controller.validateClaims" -}}
{{- $c := .Values.claims -}}
{{- if not (or .Values.variants.enabled $c.enabled) -}}
{{- fail "sandbox-controller: variants.enabled and claims.enabled are both off; the controller would do nothing." -}}
{{- end -}}
{{- if $c.enabled -}}
{{- range $field := list "tlsSecretName" "clientCASecretName" -}}
{{- if not (index $c $field) -}}
{{- fail (printf "sandbox-controller: claims.%s is required with claims.enabled: the claim API serves mTLS only." $field) -}}
{{- end -}}
{{- end -}}
{{- if not $c.database.secretName -}}
{{- fail "sandbox-controller: claims.database.secretName is required with claims.enabled." -}}
{{- end -}}
{{- if not $c.studio.namespace -}}
{{- fail "sandbox-controller: claims.studio.namespace is required with claims.enabled: the NetworkPolicy admits Studio's pods only." -}}
{{- end -}}
{{- $sel := $c.studio.podSelector | default dict -}}
{{- if not (or $sel.matchLabels $sel.matchExpressions) -}}
{{- fail "sandbox-controller: claims.studio.podSelector is empty, which would admit every pod in Studio's namespace." -}}
{{- end -}}
{{- if ne (empty $c.gateway.name) (empty $c.gateway.namespace) -}}
{{- fail "sandbox-controller: claims.gateway.name and claims.gateway.namespace are both set or both empty." -}}
{{- end -}}
{{- if and $c.tenantPools (not $c.sentinel.secretName) -}}
{{- fail "sandbox-controller: claims.tenantPools need claims.sentinel.secretName; without warm-pool mode the controller ignores them." -}}
{{- end -}}
{{- end -}}
{{- end }}
