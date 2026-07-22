{{/*
Chart name (overridable via nameOverride).
*/}}
{{- define "sandbox-operator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Chart-name-and-version label.
*/}}
{{- define "sandbox-operator.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels for resources owned by this chart.
*/}}
{{- define "sandbox-operator.labels" -}}
helm.sh/chart: {{ include "sandbox-operator.chart" . }}
app.kubernetes.io/name: {{ include "sandbox-operator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Validate that the chart is being installed into agent-sandbox-system. The
vendored upstream operator manifest (templates/agent-sandbox-manifest.yaml)
ships its own Namespace object and hardcodes that name across its
ServiceAccount, Service, Deployment, and ClusterRoleBinding. The companion
sandbox-env chart also pins agent-sandbox-system because the operator's RBAC
watches it by default. Installing under any other namespace splits resources
across two namespaces and breaks reconciliation in non-obvious ways — fail
at template time instead.
*/}}
{{- define "sandbox-operator.validateNamespace" -}}
{{- /* Opt-out: an umbrella that installs this chart as a subchart under a
different release namespace (e.g. Studio's local umbrella, release ns
"deco-studio") DOES want the split — every operator resource here is already
pinned to agent-sandbox-system explicitly, so they land there regardless of the
release namespace. Set allowForeignNamespace=true in that case. */ -}}
{{- if and (ne .Release.Namespace "agent-sandbox-system") (not .Values.allowForeignNamespace) -}}
{{- fail (printf "sandbox-operator: this chart must be installed into the 'agent-sandbox-system' namespace (got %q). The vendored upstream operator manifest hardcodes that namespace; installing elsewhere splits resources across namespaces. Re-run with --namespace agent-sandbox-system --create-namespace, or set allowForeignNamespace=true if you are installing it as a subchart on purpose." .Release.Namespace) -}}
{{- end -}}
{{- end }}
