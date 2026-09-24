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
{{- if ne (empty $c.gateway.name) (empty $c.gateway.namespace) -}}
{{- fail "sandbox-controller: claims.gateway.name and claims.gateway.namespace are both set or both empty." -}}
{{- end -}}
{{- if and $c.tenantPools (not $c.sentinel.secretName) -}}
{{- fail "sandbox-controller: claims.tenantPools need claims.sentinel.secretName; without warm-pool mode the controller ignores them." -}}
{{- end -}}
{{- end -}}
{{- end }}
