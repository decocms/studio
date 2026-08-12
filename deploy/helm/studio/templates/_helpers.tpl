{{/*
Expand the name of the chart.
*/}}
{{- define "chart-deco-studio.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
Uses only the release name, ignoring the chart name.
*/}}
{{- define "chart-deco-studio.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "chart-deco-studio.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "chart-deco-studio.labels" -}}
helm.sh/chart: {{ include "chart-deco-studio.chart" . }}
{{ include "chart-deco-studio.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Pod-template labels — same as .labels but WITHOUT helm.sh/chart. The chart label
carries the chart version, so putting it on a pod template makes every chart
version bump change the template hash and roll ALL deployments. Keep it on
Deployment metadata (.labels), not the pod template, so a version bump only
rolls a Deployment whose actual pod spec changed.
*/}}
{{- define "chart-deco-studio.podLabels" -}}
{{ include "chart-deco-studio.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "chart-deco-studio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "chart-deco-studio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "chart-deco-studio.serviceAccountName" -}}
{{- if and .Values.serviceAccount .Values.serviceAccount.create -}}
{{- default (include "chart-deco-studio.fullname" .) .Values.serviceAccount.name | trim -}}
{{- else if .Values.serviceAccount -}}
{{- default "default" .Values.serviceAccount.name | trim -}}
{{- else -}}
default
{{- end -}}
{{- end }}

{{/*
Checks if persistence configuration supports distributed writes.
*/}}
{{- define "chart-deco-studio.isDistributedStorage" -}}
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
{{- define "chart-deco-studio.usesPostgres" -}}
{{- if eq (lower (default "sqlite" .Values.database.engine)) "postgresql" }}
true
{{- else }}
false
{{- end }}
{{- end }}

{{/*
Resolves DATABASE_URL honoring database engine configuration.
*/}}
{{- define "chart-deco-studio.databaseUrl" -}}
{{- if eq (lower (default "sqlite" .Values.database.engine)) "postgresql" -}}
{{- required "database.url must be set when database.engine=postgresql" .Values.database.url | trim -}}
{{- else -}}
{{/* Historical filename retained so existing PVCs keep their database. */}}
/app/data/mesh.db
{{- end -}}
{{- end }}

{{/*
Global validations to ensure scaling requirements are met.
*/}}
{{- define "chart-deco-studio.validate" -}}
{{- $distributedStr := include "chart-deco-studio.isDistributedStorage" . | trim -}}
{{- $distributed := eq $distributedStr "true" -}}
{{- $usesPostgresStr := include "chart-deco-studio.usesPostgres" . | trim -}}
{{- $usesPostgres := eq $usesPostgresStr "true" -}}
{{- $replicas := int (default 1 .Values.replicaCount) -}}
{{- if and (not .Values.autoscaling.enabled) (not $distributed) (not $usesPostgres) (gt $replicas 1) }}
{{- fail "chart-deco-studio: replicaCount > 1 requires distributed storage (persistence.distributed=true or accessMode=ReadWriteMany) or database.engine=postgresql" -}}
{{- end }}
{{- if and .Values.autoscaling.enabled (not (or $distributed $usesPostgres)) }}
{{- fail "chart-deco-studio: autoscaling.enabled=true requires distributed storage (persistence.distributed=true or accessMode=ReadWriteMany) or database.engine=postgresql" -}}
{{- end }}
{{- if and $usesPostgres (not .Values.database.url) (not .Values.secret.secretName) (not .Values.externalSecret.enabled) }}
{{- fail "chart-deco-studio: set database.url when database.engine=postgresql, or use secret.secretName to provide DATABASE_URL via Secret" -}}
{{- end }}
{{- if and .Values.autoscaling.enabled (gt (int .Values.autoscaling.minReplicas) (int .Values.autoscaling.maxReplicas)) }}
{{- fail (printf "chart-deco-studio: autoscaling.minReplicas (%d) must not exceed autoscaling.maxReplicas (%d)" (int .Values.autoscaling.minReplicas) (int .Values.autoscaling.maxReplicas)) -}}
{{- end }}
{{- if and .Values.worker.enabled .Values.worker.autoscaling.enabled (gt (int .Values.worker.autoscaling.minReplicas) (int .Values.worker.autoscaling.maxReplicas)) }}
{{- fail (printf "chart-deco-studio: worker.autoscaling.minReplicas (%d) must not exceed worker.autoscaling.maxReplicas (%d)" (int .Values.worker.autoscaling.minReplicas) (int .Values.worker.autoscaling.maxReplicas)) -}}
{{- end }}
{{- end }}

{{/*
Guards the API/worker split: the main deployment is API-only behind nginx, so
there must be a worker deployment to pick up run queues.
*/}}
{{- define "chart-deco-studio.validateDispatchRole" -}}
{{- if not .Values.worker.enabled }}
{{- fail "chart-deco-studio: worker.enabled=true is required because the main Deployment runs API-only containers behind nginx; otherwise no pod dequeues the run queues and runs never dispatch." -}}
{{- end }}
{{- $usesPostgresStr := include "chart-deco-studio.usesPostgres" . | trim -}}
{{- if ne $usesPostgresStr "true" }}
{{- fail "chart-deco-studio: database.engine=postgresql is required for the split API/worker topology because workers and API pods must share the DBOS run queue. Provide DATABASE_URL via database.url, secret.secretName, or externalSecret." -}}
{{- end }}
{{- range $name := list "STUDIO_DISPATCH_ROLE" "MESH_DISPATCH_ROLE" }}
{{- if hasKey $.Values.configMap.meshConfig $name }}
{{- fail (printf "chart-deco-studio: configMap.meshConfig contains reserved variable %s; STUDIO_DISPATCH_ROLE is managed per container by the chart, and the legacy MESH_DISPATCH_ROLE alias must not be emitted by the chart." $name) -}}
{{- end }}
{{- end }}
{{- range $env := .Values.env }}
{{- $name := get $env "name" | default "" -}}
{{- if or (eq $name "PORT") (eq $name "STUDIO_DISPATCH_ROLE") (eq $name "MESH_DISPATCH_ROLE") (eq $name "POD_NAME") (eq $name "POD_NAME_BASE") }}
{{- fail (printf "chart-deco-studio: env contains reserved variable %s; API container PORT, STUDIO_DISPATCH_ROLE, POD_NAME, and POD_NAME_BASE are managed by the chart, and MESH_DISPATCH_ROLE is a legacy app-only alias." $name) -}}
{{- end }}
{{- end }}
{{- range $env := .Values.worker.env }}
{{- $name := get $env "name" | default "" -}}
{{- if or (eq $name "PORT") (eq $name "STUDIO_DISPATCH_ROLE") (eq $name "MESH_DISPATCH_ROLE") }}
{{- fail (printf "chart-deco-studio: worker.env contains reserved variable %s; worker PORT and STUDIO_DISPATCH_ROLE are managed by the chart, and MESH_DISPATCH_ROLE is a legacy app-only alias." $name) -}}
{{- end }}
{{- end }}
{{- end }}

{{/*
Returns podSecurityContext with fsGroupChangePolicy adjusted for volumes.
*/}}
{{- define "chart-deco-studio.podSecurityContext" -}}
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
{{- define "chart-deco-studio.deploymentStrategy" -}}
{{- $distributed := eq (include "chart-deco-studio.isDistributedStorage" . | trim) "true" -}}
{{- $usesPostgres := eq (include "chart-deco-studio.usesPostgres" . | trim) "true" -}}
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
{{- define "chart-deco-studio.secretName" -}}
{{- if .Values.secret.secretName -}}
{{- .Values.secret.secretName | trim -}}
{{- else -}}
{{- include "chart-deco-studio.fullname" . }}-secrets
{{- end -}}
{{- end }}

{{/*
Returns the Secret name that contains Studio's internal NATS cluster creds file.
Defaults to the same Secret used by envFrom, but can point at a dedicated
Secret owned by SRE.
*/}}
{{- define "chart-deco-studio.natsClusterCredsSecretName" -}}
{{- if .Values.tunnel.nats.clusterCreds.secretName -}}
{{- .Values.tunnel.nats.clusterCreds.secretName | trim -}}
{{- else -}}
{{- include "chart-deco-studio.secretName" . -}}
{{- end -}}
{{- end }}

{{/*
Absolute path exposed through NATS_CREDS when cluster creds mounting is enabled.
*/}}
{{- define "chart-deco-studio.natsClusterCredsPath" -}}
{{- printf "%s/%s" (trimSuffix "/" .Values.tunnel.nats.clusterCreds.mountDir) .Values.tunnel.nats.clusterCreds.fileName -}}
{{- end }}

{{/*
Validate OTel collector/S3 configuration.
*/}}
{{- define "chart-deco-studio.validateOtel" -}}
{{- if and .Values.s3Sync.enabled (not .Values.s3Sync.bucket) }}
{{- fail "chart-deco-studio: s3Sync.bucket is required when s3Sync.enabled=true" -}}
{{- end }}
{{- if and .Values.s3Sync.roleArn (ne .Values.s3Sync.roleArn "") }}
{{- if not (and .Values.serviceAccount .Values.serviceAccount.create) }}
{{- fail "chart-deco-studio: s3Sync.roleArn requires serviceAccount.create=true" -}}
{{- end }}
{{- end }}
{{- if and .Values.otel.collector.enabled (not .Values.otel.enabled) }}
{{- fail "chart-deco-studio: otel.collector.enabled=true requires otel.enabled=true" -}}
{{- end }}
{{- if and .Values.dbosConductor .Values.dbosConductor.enabled }}
{{- if and .Values.dbosConductor.key .Values.dbosConductor.existingSecret }}
{{- fail "chart-deco-studio: dbosConductor.key and dbosConductor.existingSecret are mutually exclusive" -}}
{{- end }}
{{- if and (not .Values.dbosConductor.key) (not .Values.dbosConductor.existingSecret) }}
{{- fail "chart-deco-studio: dbosConductor.enabled=true requires either dbosConductor.key or dbosConductor.existingSecret" -}}
{{- end }}
{{- end }}
{{- end }}

{{/*
Validates ExternalSecret configuration.
*/}}
{{- define "chart-deco-studio.validateExternalSecret" -}}
{{- if and .Values.externalSecret.enabled .Values.secret.secretName }}
{{- fail "chart-deco-studio: externalSecret.enabled=true and secret.secretName are mutually exclusive — remove secret.secretName when using ExternalSecret" -}}
{{- end }}
{{- if and .Values.externalSecret.enabled (not .Values.externalSecret.secretPath) }}
{{- fail "chart-deco-studio: externalSecret.secretPath is required when externalSecret.enabled=true" -}}
{{- end }}
{{- end }}

{{/*
Validates the optional Ingress. An enabled Ingress with no host renders a
rules-less object the controller accepts and silently routes nothing, so fail
at render time instead.
*/}}
{{- define "chart-deco-studio.validateIngress" -}}
{{- if .Values.ingress.enabled }}
{{- if not .Values.ingress.hosts }}
{{- fail "chart-deco-studio: ingress.hosts is required when ingress.enabled=true" -}}
{{- end }}
{{- range .Values.ingress.hosts }}
{{- if not .host }}
{{- fail "chart-deco-studio: every entry in ingress.hosts needs a host" -}}
{{- end }}
{{- if not .paths }}
{{- fail (printf "chart-deco-studio: ingress host %s has no paths — add at least { path: /, pathType: Prefix }" .host) -}}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Validates public NATS tunnel cluster-creds mount configuration.
*/}}
{{- define "chart-deco-studio.validateNatsTunnel" -}}
{{- with .Values.tunnel.nats.clusterCreds }}
{{- if .enabled }}
{{- if not .secretKey }}
{{- fail "chart-deco-studio: tunnel.nats.clusterCreds.secretKey is required when clusterCreds.enabled=true" -}}
{{- end }}
{{- if not .mountDir }}
{{- fail "chart-deco-studio: tunnel.nats.clusterCreds.mountDir is required when clusterCreds.enabled=true" -}}
{{- end }}
{{- if not .fileName }}
{{- fail "chart-deco-studio: tunnel.nats.clusterCreds.fileName is required when clusterCreds.enabled=true" -}}
{{- end }}
{{- if and (not .secretName) (not $.Values.secret.secretName) (not $.Values.externalSecret.enabled) (not $.Values.secret.NATS_CLUSTER_CREDS) }}
{{- fail "chart-deco-studio: secret.NATS_CLUSTER_CREDS is required when clusterCreds.enabled=true and no existing Secret/ExternalSecret/dedicated clusterCreds.secretName is configured" -}}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Whether the clickhouse-cluster subchart renders a ClickHouseCluster CR.
*/}}
{{- define "chart-deco-studio.clickhouseEnabled" -}}
{{- $cl := index .Values "clickhouse-cluster" | default dict -}}
{{- if and (dig "enabled" false $cl) (dig "clickhouse" "enabled" true $cl) -}}
true
{{- else -}}
false
{{- end -}}
{{- end }}

{{/*
Name of the ClickHouseCluster CR the clickhouse-cluster subchart renders.
Mirrors its clickhouse-cluster.clickhouse.name helper (meta.name, else
release-scoped fullname) so CLICKHOUSE_URL can point at the operator-managed
Service (<cr-name>-clickhouse-headless).
*/}}
{{- define "chart-deco-studio.clickhouseCrName" -}}
{{- $cl := index .Values "clickhouse-cluster" | default dict -}}
{{- $meta := dig "clickhouse" "meta" "name" "" $cl -}}
{{- if $meta -}}
{{- $meta | trunc 63 | trimSuffix "-" -}}
{{- else if contains "clickhouse-cluster" .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-clickhouse-cluster" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{/*
Validates the embedded ClickHouse operator/cluster configuration. The upstream
operator chart only takes a static namespace list (no tpl), so scoping to the
install namespace can't be derived — enforce it here, where the release
namespace is known.
*/}}
{{- define "chart-deco-studio.validateClickhouse" -}}
{{- $op := index .Values "clickhouse-operator" | default dict -}}
{{- if dig "enabled" false $op }}
{{- $watch := dig "controller" "watchNamespaces" (list) $op -}}
{{- if not $watch }}
{{- fail (printf "chart-deco-studio: set clickhouse-operator.controller.watchNamespaces=[%s] (this release's namespace) so the embedded operator only watches Studio's namespace. For a cluster-wide operator, install clickhouse-operator-helm separately and enable only clickhouse-cluster." .Release.Namespace) -}}
{{- end }}
{{- if and (eq (include "chart-deco-studio.clickhouseEnabled" .) "true") (not (has .Release.Namespace $watch)) }}
{{- fail (printf "chart-deco-studio: clickhouse-operator.controller.watchNamespaces=%v does not include %q — the operator would never reconcile the ClickHouseCluster CR this chart renders." $watch .Release.Namespace) -}}
{{- end }}
{{- end }}
{{- end }}

{{/*
Formats OTEL headers map as key=value,key2=value2 format.
*/}}
{{- define "chart-deco-studio.otelHeaders" -}}
{{- $headers := list -}}
{{- range $key, $value := .Values.otel.headers -}}
{{- $headers = append $headers (printf "%s=%s" $key $value) -}}
{{- end -}}
{{- join "," $headers -}}
{{- end }}

{{/*
Formats OTEL resource attributes map as key=value,key2=value2 format.
*/}}
{{- define "chart-deco-studio.otelAttributes" -}}
{{- $attrs := list -}}
{{- range $key, $value := .Values.otel.attributes -}}
{{- $attrs = append $attrs (printf "%s=%s" $key $value) -}}
{{- end -}}
{{- join "," $attrs -}}
{{- end }}
