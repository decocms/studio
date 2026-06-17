{{/*
Shared pod template body used by both Deployment and Rollout workload kinds.

This contains everything from `template:` down to (but not including) the
workload-level `strategy:` block — i.e. metadata + spec for the pod.

Keep all pod-level concerns here (container env, volumes, securityContext, etc.)
so the Deployment ↔ Rollout opt-in stays a one-line toggle for consumers and the
two workload templates stay byte-identical in pod surface.
*/}}
{{- define "chart-deco-studio.podTemplate" -}}
metadata:
  {{- with .Values.podAnnotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  labels:
    {{- include "chart-deco-studio.labels" . | nindent 4 }}
    {{- with .Values.podLabels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  {{- /* hasKey honors an explicit `0` (immediate termination); the
        previous truthiness check silently dropped it. */}}
  {{- if hasKey .Values "terminationGracePeriodSeconds" }}
  terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
  {{- end }}
  {{- with .Values.imagePullSecrets }}
  imagePullSecrets:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  serviceAccountName: {{ include "chart-deco-studio.serviceAccountName" . }}
  securityContext:
    {{- include "chart-deco-studio.podSecurityContext" . | nindent 4 }}
  containers:
    - name: {{ .Chart.Name }}
      {{- with .Values.securityContext }}
      securityContext:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      image: "{{ .Values.image.repository }}{{- if and .Values.image.tag (hasPrefix "sha256:" .Values.image.tag) }}@{{ .Values.image.tag }}{{- else }}:{{ .Values.image.tag | default .Chart.AppVersion }}{{- end }}"
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      {{- with .Values.image.command }}
      command:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      ports:
        - name: http
          containerPort: {{ .Values.service.targetPort | default 3000 }}
          protocol: TCP
      envFrom:
        - configMapRef:
            name: {{ include "chart-deco-studio.fullname" . }}-config
        - secretRef:
            name: {{ include "chart-deco-studio.secretName" . }}
      env:
        {{- if .Values.otel.enabled }}
        {{- if .Values.otel.protocol }}
        - name: OTEL_EXPORTER_OTLP_PROTOCOL
          value: {{ .Values.otel.protocol | quote }}
        {{- end }}
        {{- if .Values.otel.service }}
        - name: OTEL_SERVICE_NAME
          value: {{ .Values.otel.service | quote }}
        {{- end }}
        {{- if .Values.otel.endpoint }}
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: {{ .Values.otel.endpoint | quote }}
        {{- else if .Values.otel.collector.enabled }}
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: {{ printf "http://%s-opentelemetry-collector:4318" .Release.Name | quote }}
        {{- end }}
        {{- if and .Values.otel.headers (or (not .Values.otel.collector.enabled) .Values.otel.endpoint) }}
        - name: OTEL_EXPORTER_OTLP_HEADERS
          value: {{ include "chart-deco-studio.otelHeaders" . | quote }}
        {{- end }}
        {{- if .Values.otel.attributes }}
        - name: OTEL_RESOURCE_ATTRIBUTES
          value: {{ include "chart-deco-studio.otelAttributes" . | quote }}
        {{- end }}
        {{- end }}
        {{- if and .Values.dbosConductor .Values.dbosConductor.enabled }}
        - name: DBOS_CONDUCTOR_KEY
          valueFrom:
            secretKeyRef:
              name: {{ .Values.dbosConductor.existingSecret | default (printf "%s-dbos-conductor" (include "chart-deco-studio.fullname" .)) }}
              key: {{ .Values.dbosConductor.existingSecretKey | default "DBOS_CONDUCTOR_KEY" }}
        {{- with .Values.dbosConductor.url }}
        - name: DBOS_CONDUCTOR_URL
          value: {{ . | quote }}
        {{- end }}
        {{- end }}
        {{- with .Values.env }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      {{- with .Values.livenessProbe }}
      livenessProbe:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.readinessProbe }}
      readinessProbe:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.lifecycle }}
      lifecycle:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.resources }}
      resources:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      volumeMounts:
        - name: data
          mountPath: {{ .Values.configMap.meshConfig.DATA_DIR | default "/app/data" }}
        {{- if and (eq (lower (default "sqlite" .Values.database.engine)) "postgresql") .Values.database.caCert }}
        - name: ca-cert
          mountPath: /etc/ssl/certs
          readOnly: true
        {{- end }}
        {{- with .Values.volumeMounts }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
  {{- if .Values.s3Sync.enabled }}
    - name: s3-sync
      image: "{{ .Values.s3Sync.image.repository }}:{{ .Values.s3Sync.image.tag }}"
      imagePullPolicy: {{ .Values.s3Sync.image.pullPolicy }}
      command: ["/bin/sh", "/scripts/sync.sh"]
      {{- with .Values.securityContext }}
      securityContext:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.s3Sync.resources }}
      resources:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      volumeMounts:
        - name: data
          mountPath: {{ .Values.configMap.meshConfig.DATA_DIR | default "/app/data" }}
        - name: s3-sync-script
          mountPath: /scripts
          readOnly: true
  {{- end }}
  {{- with .Values.extraContainers }}
  {{- toYaml . | nindent 4 }}
  {{- end }}
  volumes:
    {{- if and (eq (lower (default "sqlite" .Values.database.engine)) "postgresql") .Values.database.caCert }}
    - name: ca-cert
      configMap:
        name: {{ include "chart-deco-studio.fullname" . }}-ca-cert
        items:
          - key: ca-cert.pem
            path: ca-cert.pem
    {{- end }}
    {{- if .Values.persistence.enabled }}
    - name: data
      {{- if .Values.persistence.claimName }}
      persistentVolumeClaim:
        claimName: {{ .Values.persistence.claimName }}
      {{- else }}
      persistentVolumeClaim:
        claimName: {{ include "chart-deco-studio.fullname" . }}-data
      {{- end }}
    {{- else }}
    - name: data
      emptyDir:
        sizeLimit: {{ .Values.persistence.emptyDirSizeLimit | default "10Gi" }}
    {{- end }}
    {{- if .Values.s3Sync.enabled }}
    - name: s3-sync-script
      configMap:
        name: {{ include "chart-deco-studio.fullname" . }}-s3-sync
        defaultMode: 0755
        items:
          - key: sync.sh
            path: sync.sh
    {{- end }}
    {{- with .Values.volumes }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- with .Values.nodeSelector }}
  nodeSelector:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.affinity }}
  affinity:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.tolerations }}
  tolerations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- if and .Values.topologySpreadConstraints (gt (len .Values.topologySpreadConstraints) 0) }}
  topologySpreadConstraints:
    {{- range .Values.topologySpreadConstraints }}
    - {{- if not .labelSelector }}
      {{- fail "labelSelector é obrigatório em topologySpreadConstraints. Especifique explicitamente os labels." }}
      {{- else }}
      labelSelector:
        {{- toYaml .labelSelector | nindent 8 }}
      {{- end }}
      maxSkew: {{ .maxSkew }}
      topologyKey: {{ .topologyKey }}
      whenUnsatisfiable: {{ .whenUnsatisfiable }}
    {{- end }}
  {{- end }}
{{- end }}
