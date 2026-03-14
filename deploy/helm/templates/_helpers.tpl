{{/*
Expand the name of the chart.
*/}}
{{- define "chart-decocms.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
Uses only the release name, ignoring the chart name.
*/}}
{{- define "chart-decocms.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "chart-decocms.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "chart-decocms.labels" -}}
helm.sh/chart: {{ include "chart-decocms.chart" . }}
{{ include "chart-decocms.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "chart-decocms.selectorLabels" -}}
app.kubernetes.io/name: {{ include "chart-decocms.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "chart-decocms.serviceAccountName" -}}
{{- if and .Values.serviceAccount .Values.serviceAccount.create -}}
{{- default (include "chart-decocms.fullname" .) .Values.serviceAccount.name | trim -}}
{{- else if .Values.serviceAccount -}}
{{- default "default" .Values.serviceAccount.name | trim -}}
{{- else -}}
default
{{- end -}}
{{- end }}

{{/*
Checks if persistence configuration supports distributed writes.
*/}}
{{- define "chart-decocms.isDistributedStorage" -}}
{{- $p := .Values.persistence -}}
{{- if not $p -}}
false
{{- else if not $p.enabled -}}
false
{{- else -}}
{{- $accessMode := lower (default "" $p.accessMode) -}}
{{- $isReadWriteMany := eq $accessMode "readwritemany" -}}
{{- $isDistributed := $p.distributed | default false -}}
{{- if or $isReadWriteMany $isDistributed -}}
true
{{- else -}}
false
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Checks if database engine is PostgreSQL.
*/}}
{{- define "chart-decocms.usesPostgres" -}}
{{- if eq (lower (default "sqlite" .Values.database.engine)) "postgresql" }}
true
{{- else }}
false
{{- end }}
{{- end }}

{{/*
Resolves DATABASE_URL honoring database engine configuration.
*/}}
{{- define "chart-decocms.databaseUrl" -}}
{{- if eq (lower (default "sqlite" .Values.database.engine)) "postgresql" -}}
{{- required "database.url deve ser definido quando database.engine=postgresql" .Values.database.url | trim -}}
{{- else -}}
/app/data/mesh.db
{{- end -}}
{{- end }}

{{/*
Global validations to ensure scaling requirements are met.
*/}}
{{- define "chart-decocms.validate" -}}
{{- $distributedStr := include "chart-decocms.isDistributedStorage" . | trim -}}
{{- $distributed := eq $distributedStr "true" -}}
{{- $usesPostgresStr := include "chart-decocms.usesPostgres" . | trim -}}
{{- $usesPostgres := eq $usesPostgresStr "true" -}}
{{- $replicas := int (default 1 .Values.replicaCount) -}}
{{- if and (not .Values.autoscaling.enabled) (not $distributed) (not $usesPostgres) (gt $replicas 1) }}
{{- fail "chart-decocms: replicaCount > 1 exige storage distribuído (persistence.distributed=true ou accessMode=ReadWriteMany) ou database.engine=postgresql" -}}
{{- end }}
{{- if and .Values.autoscaling.enabled (not (or $distributed $usesPostgres)) }}
{{- fail "chart-decocms: autoscaling.enabled=true exige storage distribuído (persistence.distributed=true ou accessMode=ReadWriteMany) ou database.engine=postgresql" -}}
{{- end }}
{{- if and $usesPostgres (not .Values.database.url) (not .Values.secret.secretName) }}
{{- fail "chart-decocms: defina database.url quando database.engine=postgresql ou use secret.secretName para fornecer DATABASE_URL via Secret" -}}
{{- end }}
{{- end }}

{{/*
Returns podSecurityContext with fsGroupChangePolicy adjusted for volumes.
*/}}
{{- define "chart-decocms.podSecurityContext" -}}
{{- if .Values.podSecurityContext }}
{{- toYaml .Values.podSecurityContext }}
{{- else }}
fsGroup: 1001
fsGroupChangePolicy: "OnRootMismatch"
{{- end }}
{{- end }}

{{/*
Determines the deployment strategy based on database and storage configuration.
Uses RollingUpdate if PostgreSQL or distributed storage, otherwise Recreate.
*/}}
{{- define "chart-decocms.deploymentStrategy" -}}
{{- $distributed := eq (include "chart-decocms.isDistributedStorage" .) "true" -}}
{{- $usesPostgres := eq (include "chart-decocms.usesPostgres" .) "true" -}}
{{- if and .Values.strategy .Values.strategy.type -}}
{{- .Values.strategy.type | trim -}}
{{- else if or $distributed $usesPostgres -}}
RollingUpdate
{{- else -}}
Recreate
{{- end -}}
{{- end }}

{{/*
Returns the secret name to use. If secret.secretName is defined, uses it.
Otherwise, uses the generated name.
*/}}
{{- define "chart-decocms.secretName" -}}
{{- if .Values.secret.secretName -}}
{{- .Values.secret.secretName | trim -}}
{{- else -}}
{{- include "chart-decocms.fullname" . }}-secrets
{{- end -}}
{{- end }}

{{/*
Validate OTel collector/S3 configuration.
*/}}
{{- define "chart-decocms.validateOtel" -}}
{{- if and .Values.s3Sync.enabled (not .Values.s3Sync.bucket) }}
{{- fail "chart-decocms: s3Sync.bucket is required when s3Sync.enabled=true" -}}
{{- end }}
{{- if and .Values.s3Sync.roleArn (ne .Values.s3Sync.roleArn "") }}
{{- if not (and .Values.serviceAccount .Values.serviceAccount.create) }}
{{- fail "chart-decocms: s3Sync.roleArn requires serviceAccount.create=true" -}}
{{- end }}
{{- end }}
{{- end }}

{{/*
Formats OTEL headers map as key=value,key2=value2 format.
*/}}
{{- define "chart-decocms.otelHeaders" -}}
{{- $headers := list -}}
{{- range $key, $value := .Values.otel.headers -}}
{{- $headers = append $headers (printf "%s=%s" $key $value) -}}
{{- end -}}
{{- join "," $headers -}}
{{- end }}

{{/*
Formats OTEL resource attributes map as key=value,key2=value2 format.
*/}}
{{- define "chart-decocms.otelAttributes" -}}
{{- $attrs := list -}}
{{- range $key, $value := .Values.otel.attributes -}}
{{- $attrs = append $attrs (printf "%s=%s" $key $value) -}}
{{- end -}}
{{- join "," $attrs -}}
{{- end }}
