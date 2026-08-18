{{/*
Per-PR preview tag, as an Argo Go-template expression evaluated by the
ApplicationSet controller (NOT by Helm).

The 7-char prefix of `.head_sha` is load bearing: it must be the same commit the
preview-build workflow tags its images with. A `pull_request`-triggered checkout
lands on refs/pull/N/merge, whose HEAD is an ephemeral merge commit that this
generator has no way to name — so the workflow must tag from
`github.event.pull_request.head.sha`, not from `git rev-parse HEAD`.
*/}}
{{- define "studio-previews.imageTag" -}}
{{ .Values.images.tagPrefix }}-{{ `{{ .number }}` }}-{{ `{{ substr 0 7 .head_sha }}` }}
{{- end }}

{{/*
Release/namespace name of a generated preview.
*/}}
{{- define "studio-previews.appName" -}}
{{ .Values.namePrefix }}-{{ `{{ .number }}` }}
{{- end }}

{{/*
Public origin of a generated preview.
*/}}
{{- define "studio-previews.host" -}}
{{ .Values.namePrefix }}-{{ `{{ .number }}` }}.{{ .Values.domain }}
{{- end }}
