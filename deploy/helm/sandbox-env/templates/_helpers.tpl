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
Sandbox container image. The daemon implementation IS the image, so there is no
runtime switch a pod could use to disagree with the template that created it.
*/}}
{{- define "sandbox-env.sandboxImage" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
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
OTLP endpoint handed to the daemon, built from the same ip/port the netinit
ACCEPT rule is built from so the configured destination is by construction the
reachable one. Fails at template time rather than shipping a sandbox that
retries into a REJECT for its whole life.
*/}}
{{- define "sandbox-env.otlpEndpoint" -}}
{{- if not .Values.telemetry.otlp.ip }}
{{- fail "sandbox-env: telemetry.enabled requires telemetry.otlp.ip — the OTLP collector's ClusterIP. A DNS name will NOT work: sandboxes use dnsPolicy: None with public resolvers, so in-cluster names do not resolve. Get it with: kubectl -n opentelemetry-collector get svc gateway-otlp -o jsonpath='{.spec.clusterIP}'" -}}
{{- end }}
{{- if not (regexMatch "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$" .Values.telemetry.otlp.ip) }}
{{- fail (printf "sandbox-env: telemetry.otlp.ip must be a bare IPv4 address, got %q. It is interpolated into an iptables -d rule; a hostname there fails the init container and the pod never starts." .Values.telemetry.otlp.ip) -}}
{{- end }}
{{- printf "http://%s:%v" .Values.telemetry.otlp.ip .Values.telemetry.otlp.port -}}
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

{{/*
Catch warmPool.enabled=true left at the default warmPool.size (0): the
SandboxWarmPool renders with replicas: 0, a no-op that pre-warms nothing
while still looking "enabled" — the same balloon-with-0-replicas trap
validateNodePlaceholder already guards against below. Skipped when
autoscaling is on, since the HPA drives replicas post-render regardless of
this static value.
*/}}
{{- define "sandbox-env.validateWarmPoolSize" -}}
{{- if and .Values.warmPool.enabled (not .Values.warmPool.autoscaling.enabled) }}
{{- if lt (int .Values.warmPool.size) 1 }}
{{- fail (printf "sandbox-env: warmPool.enabled=true requires warmPool.size >= 1 (got %v) — a pool with 0 replicas pre-warms nothing." .Values.warmPool.size) -}}
{{- end }}
{{- end }}
{{- end }}

{{/*
Validate tenantPools. The name is deliberately NOT derived here — Studio's
STUDIO_SANDBOX_TENANT_POOLS carries the same literal, and deriving it on both
sides is a mismatch waiting to happen. But this chart shares
`agent-sandbox-system` across releases (that is why every other object is
suffixed with envName), so an undecorated literal lets dev/staging/prod fight
over one SandboxWarmPool. Require the suffix instead of adding it: the string
stays identical on both sides, and a collision is a template-time failure.
*/}}
{{- define "sandbox-env.validateTenantPools" -}}
{{- $env := include "sandbox-env.envName" . -}}
{{- range .Values.tenantPools }}
{{- if not .name }}
{{- fail "sandbox-env: every tenantPools entry needs a `name` (it names a SandboxWarmPool and must equal the Studio-side entry)." -}}
{{- end }}
{{- if not (hasSuffix (printf "-%s" $env) .name) }}
{{- fail (printf "sandbox-env: tenantPools name %q must end with -%s so releases sharing agent-sandbox-system don't collide (e.g. tenant-acme-site-%s). Use the SAME string in Studio's STUDIO_SANDBOX_TENANT_POOLS." .name $env $env) -}}
{{- end }}
{{- if lt (int .size) 1 }}
{{- fail (printf "sandbox-env: tenantPools[%s].size must be >= 1 (got %v) — a pool with 0 replicas pre-warms nothing." .name .size) -}}
{{- end }}
{{- end }}
{{- end }}

{{- define "sandbox-env.housekeeperName" -}}
{{- printf "sandbox-housekeeper-%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{/*
Validate the node-placeholder block before rendering the Deployment. Catch at
template time rather than shipping a balloon that can't do its job:
  - replicas < 1: nothing is reserved, so the Deployment is a no-op.
  - empty priorityClassName: a balloon at default priority (0) ties with real
    sandbox pods and would NOT be preempted — it would instead compete for and
    hold the very capacity it is meant to yield. It MUST reference a low /
    negative-priority class.
*/}}
{{- define "sandbox-env.validateNodePlaceholder" -}}
{{- if .Values.nodePlaceholder.enabled }}
{{- if lt (int .Values.nodePlaceholder.replicas) 1 }}
{{- fail (printf "sandbox-env: nodePlaceholder.enabled=true requires nodePlaceholder.replicas >= 1 (got %v) — a balloon with 0 replicas reserves no capacity." .Values.nodePlaceholder.replicas) -}}
{{- end }}
{{- if not .Values.nodePlaceholder.priorityClassName }}
{{- fail "sandbox-env: nodePlaceholder.enabled=true requires nodePlaceholder.priorityClassName pointing at a LOW / negative-priority PriorityClass (e.g. placeholder-priority). Without it the balloon runs at priority 0 and real sandbox pods can't preempt it." -}}
{{- end }}
{{- end }}
{{- end }}

{{/*
Node-placeholder (balloon) name. Reserves warm NODE capacity on the sandbox
NodePool so SandboxWarmPool refill / cold claims schedule onto an already-up
node instead of waiting on Karpenter. Per-env suffix so multiple releases
sharing the NodePool coexist.
*/}}
{{- define "sandbox-env.nodePlaceholderName" -}}
{{- printf "studio-sandbox-placeholder-%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{/*
Selector labels for the node-placeholder Deployment. Distinct component so
dashboards split balloon capacity from real sandbox pods and warm-pool pods.
*/}}
{{- define "sandbox-env.nodePlaceholderSelectorLabels" -}}
app.kubernetes.io/name: {{ include "sandbox-env.nodePlaceholderName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "sandbox-env.nodePlaceholderLabels" -}}
helm.sh/chart: {{ include "sandbox-env.chart" . }}
{{ include "sandbox-env.nodePlaceholderSelectorLabels" . }}
app.kubernetes.io/component: sandbox-placeholder
studio.decocms.com/env: {{ include "sandbox-env.envName" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Node-placeholder scheduling, defaulting to the sandbox pod's own placement so
the balloon lands on the SAME dedicated NodePool as real sandbox pods (that is
the entire point — warming general-pool nodes does nothing for a taint-isolated
sandbox pool). Each key falls back to the sandbox value unless explicitly
overridden under nodePlaceholder.
*/}}
{{- define "sandbox-env.nodePlaceholderNodeSelector" -}}
{{- default .Values.nodeSelector .Values.nodePlaceholder.nodeSelector | toYaml -}}
{{- end }}

{{- define "sandbox-env.nodePlaceholderTolerations" -}}
{{- default .Values.tolerations .Values.nodePlaceholder.tolerations | toYaml -}}
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

{{/*
Name of the chart-managed L2 golden PV and PVC. envName-suffixed like every
other resource here: the PV is CLUSTER-scoped, so two releases installing
without the suffix would collide outright, and the PVC shares
agent-sandbox-system with every other release.
*/}}
{{- define "sandbox-env.goldenRemoteName" -}}
{{- printf "studio-sandbox-golden-%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{/*
Node-level uploader: DaemonSet, plus its own writable PV/PVC over the same
store. A distinct name from goldenRemoteName because the two volumes differ in
exactly the thing that matters — the tenant's is read-only at the mount, this
one is not.
*/}}
{{- define "sandbox-env.goldenUploaderName" -}}
{{- printf "studio-sandbox-golden-uploader-%s" (include "sandbox-env.envName" .) -}}
{{- end }}

{{/*
Claim the uploader writes through. An explicit goldenUploader.pvcName wins and
this chart renders no PV/PVC — the escape hatch for a store this chart does not
manage.
*/}}
{{- define "sandbox-env.goldenUploaderClaimName" -}}
{{- if .Values.goldenUploader.pvcName -}}
{{- .Values.goldenUploader.pvcName -}}
{{- else -}}
{{- include "sandbox-env.goldenUploaderName" . -}}
{{- end -}}
{{- end }}

{{- define "sandbox-env.goldenUploaderSelectorLabels" -}}
app.kubernetes.io/name: {{ include "sandbox-env.goldenUploaderName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "sandbox-env.goldenUploaderLabels" -}}
helm.sh/chart: {{ include "sandbox-env.chart" . }}
{{ include "sandbox-env.goldenUploaderSelectorLabels" . }}
app.kubernetes.io/component: golden-uploader
studio.decocms.com/env: {{ include "sandbox-env.envName" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Placement defaults to the sandbox pods': the hostPath this reads only exists on
nodes that ran one, so following them is the correct default rather than a
convenience.
*/}}
{{- define "sandbox-env.goldenUploaderNodeSelector" -}}
{{- default .Values.nodeSelector .Values.goldenUploader.nodeSelector | toYaml -}}
{{- end }}

{{- define "sandbox-env.goldenUploaderTolerations" -}}
{{- default .Values.tolerations .Values.goldenUploader.tolerations | toYaml -}}
{{- end }}

{{/*
Validate the uploader before rendering a DaemonSet that cannot do its job.
  - it reads the node-local store and writes the shared one, so both tiers must
    be on.
  - it needs a writable view of the shared store: either this chart provisions
    one from depsCache.remote.volume.attributes, or an existing claim is named.
    Neither means a DaemonSet that crash-loops on a missing volume.
*/}}
{{- define "sandbox-env.validateGoldenUploader" -}}
{{- if .Values.goldenUploader.enabled }}
{{- if not (and .Values.depsCache.enabled .Values.depsCache.remote.enabled) }}
{{- fail "sandbox-env: goldenUploader.enabled=true requires depsCache.enabled and depsCache.remote.enabled — it bridges the node-local store to the shared one, so with either off there is nothing to read or nowhere to write." -}}
{{- end }}
{{- if and (not .Values.depsCache.remote.volume.attributes) (not .Values.goldenUploader.pvcName) }}
{{- fail "sandbox-env: goldenUploader.enabled=true needs a writable view of the shared store — either depsCache.remote.volume.attributes (this chart renders a second, writable PV over the same store) or goldenUploader.pvcName (an existing writable claim). With the dynamic storageClassName path you must supply pvcName, because a StorageClass cannot express the read-only/read-write split this relies on." -}}
{{- end }}
{{- end }}
{{- end }}

{{/*
Claim the sandbox pod mounts for the L2 store. An explicit
`depsCache.remote.pvcName` wins and nothing is rendered by
sandbox-golden-remote.yaml — that is the escape hatch for a volume this chart
does not manage (a different backend, or one provisioned by hand). Otherwise
the claim is the chart's own, created alongside its PV from
`depsCache.remote.bucketName`.
*/}}
{{- define "sandbox-env.goldenRemoteClaimName" -}}
{{- if .Values.depsCache.remote.pvcName -}}
{{- .Values.depsCache.remote.pvcName -}}
{{- else -}}
{{- include "sandbox-env.goldenRemoteName" . -}}
{{- end -}}
{{- end }}

{{/*
Validate the L2 remote block. Fail at template time rather than shipping a pod
that cannot mount, or one that silently mounts nothing:
  - remote without the node-local tier is incoherent: an L2 hit seeds L1 via
    the same pendingGolden path, and the daemon reads DEPS_CACHE_ROOT either
    way.
  - exactly ONE volume source. The three are mutually exclusive by
    construction (each implies a different set of objects to render), so two
    set is ambiguous authority and zero set would render a claim with neither
    a StorageClass nor a volumeName — Pending forever, silently.
*/}}
{{- define "sandbox-env.validateGoldenRemote" -}}
{{- if .Values.depsCache.remote.enabled }}
{{- $r := .Values.depsCache.remote -}}
{{- if not .Values.depsCache.enabled }}
{{- fail "sandbox-env: depsCache.remote.enabled=true requires depsCache.enabled=true — the L2 archive restores into the node-local store, so there is nothing for it to seed otherwise." -}}
{{- end }}
{{- $sources := list -}}
{{- if ne (default "" $r.storageClassName) "" }}{{- $sources = append $sources "storageClassName" -}}{{- end }}
{{- if $r.volume.attributes }}{{- $sources = append $sources "volume.attributes" -}}{{- end }}
{{- if ne (default "" $r.pvcName) "" }}{{- $sources = append $sources "pvcName" -}}{{- end }}
{{- if gt (len $sources) 1 }}
{{- fail (printf "sandbox-env: depsCache.remote takes exactly ONE volume source, got %d (%s). storageClassName = dynamic (this chart renders only the PVC); volume.attributes = static (renders PV + PVC, for a driver with no provisioner such as mountpoint-S3); pvcName = mount an existing claim this chart does not manage." (len $sources) (join ", " $sources)) -}}
{{- end }}
{{- if eq (len $sources) 0 }}
{{- fail "sandbox-env: depsCache.remote.enabled=true requires one volume source — storageClassName (dynamic provisioning: bring your own RWX CSI driver and StorageClass), volume.attributes (static: e.g. bucketName for mountpoint-S3, which has no dynamic provisioner), or pvcName (an existing claim). With none set the PVC would have neither a StorageClass nor a volumeName and stay Pending forever." -}}
{{- end }}
{{- if and $r.volume.attributes (eq (default "" $r.volume.driver) "") }}
{{- fail "sandbox-env: depsCache.remote.volume.attributes is set but volume.driver is empty — the static path renders a PV, whose csi.driver must name the installed CSI driver (e.g. s3.csi.aws.com)." -}}
{{- end }}
{{- end }}
{{- end }}

{{/*
Sandbox pod spec, shared by the chart-wide SandboxTemplate and by each
tenantPools entry's own template. Called with a dict: `root` is the chart
context (every .Values/.Chart/.Release inside reads through it) and `pool` is
the tenantPools entry, or an empty dict for the shared template.

One partial, not two templates: resources (and later node placement) are pod
spec fields, so a per-tenant value REQUIRES a per-tenant SandboxTemplate --
and a hand-copied 400-line duplicate of this would drift the first time
someone edited one of them.
*/}}
{{- define "sandbox-env.sandboxTemplateSpec" -}}
{{- $root := .root -}}
{{- $pool := .pool | default dict -}}
spec:
  # The operator's controller rejects per-claim env outright when
  # `claim.spec.warmpool != "none"`, so warm-pool consumption requires
  # all claim env to come from the template. We bake a *sentinel* bearer
  # token (rendered into a Secret by sandbox-sentinel-secret.yaml) and
  # rotate to a per-claim token post-bind via Studio's first
  # POST /_sandbox/config call. envVarsInjectionPolicy stays Allowed
  # so single-env deploys that haven't yet adopted the sentinel can still
  # provision cold (warmpool=none) with claim env.
  envVarsInjectionPolicy: Allowed
  # The CRD defaults to Managed, which makes the operator install its own
  # NetworkPolicy. Egress enforcement is handled by the iptables init
  # container instead, so the operator's policy is disabled here.
  networkPolicyManagement: Unmanaged
  podTemplate:
    metadata:
      {{- if or $root.Values.netinit.enabled $root.Values.disruptionProtection.doNotDisrupt }}
      annotations:
        {{- if $root.Values.netinit.enabled }}
        # Best-effort AWS VPC CNI opt-out. The real safety net is that no
        # NetworkPolicy selects these pods (networkPolicyManagement:
        # Unmanaged + no chart-rendered NP), so the agent's policy-endpoint
        # controller never flips them into POLICIES_APPLIED. This key isn't
        # in aws-network-policy-agent's source — verify it's honored before
        # relying on it if a future NP starts matching these pods.
        vpc.amazonaws.com/v1alpha1.network-policy-enforcement: "disabled"
        {{- end }}
        {{- if $root.Values.disruptionProtection.doNotDisrupt }}
        # Blocks Karpenter's voluntary node consolidation/drift from
        # evicting this pod mid-session. See values.yaml disruptionProtection.
        karpenter.sh/do-not-disrupt: "true"
        {{- end }}
      {{- end }}
      labels:
        # Per-env name so each env's NetworkPolicy podSelector matches only
        # its own pods. The Studio runner stamps the same value via
        # SandboxClaim.additionalPodMetadata (driven by
        # STUDIO_SANDBOX_TEMPLATE_NAME pointing at the env-suffixed
        # template) — keep these in lockstep.
        app.kubernetes.io/name: {{ include "sandbox-env.sandboxName" $root }}
        # Do NOT set `studio.decocms.com/role` here. The operator (v0.4.2+)
        # rejects claims whose additionalPodMetadata defines a label key
        # already present in the template — even when the values differ —
        # with "metadata override conflict". The runner sets role=claimed
        # via additionalPodMetadata, so the template must leave that key
        # undefined. Warm-pool pods end up without the role label;
        # dashboards filter by absence-of-handle instead.
    spec:
      automountServiceAccountToken: false
      # Room for the daemon's SIGTERM git-sync (commit + push, push bounded at
      # 30s) before SIGKILL — the pushed branch is the only durable copy of the
      # user's work. See values.yaml.
      terminationGracePeriodSeconds: {{ $root.Values.terminationGracePeriodSeconds }}
      {{- with $root.Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $root.Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $root.Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $root.Values.topologySpreadConstraints }}
      topologySpreadConstraints:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- if $root.Values.dnsPolicy }}
      dnsPolicy: {{ $root.Values.dnsPolicy }}
      {{- end }}
      {{- with $root.Values.dnsConfig }}
      dnsConfig:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      # org-fs's privileged FUSE sidecar + Bidirectional mount propagation
      # are incompatible with user-namespace remapping, so hostUsers tracks
      # the sidecar: true (no userns-remap) when org-fs is on (the default),
      # false (userns-remap restored) when disableFsSidecar opts out. The
      # untrusted agent container is locked down independently either way
      # (drop ALL caps, no privilege escalation, runAsNonRoot, seccomp
      # RuntimeDefault below); only the org-fs sidecar is privileged.
      hostUsers: {{ not $root.Values.disableFsSidecar }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      {{- if or $root.Values.netinit.enabled $root.Values.depsCache.enabled }}
      initContainers:
        {{- if $root.Values.depsCache.enabled }}
        # hostPath dirs are created root:root and fsGroup does not apply to
        # hostPath volumes, so hand the cache root to the sandbox uid once
        # per pod (idempotent). Reuses the sandbox image — already on the
        # node, no extra pull.
        - name: deps-cache-init
          image: "{{ include "sandbox-env.sandboxImage" $root }}"
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          command: ["sh", "-c", "chown 1000:1000 /deps-cache"]
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              cpu: 100m
              memory: 32Mi
          securityContext:
            runAsUser: 0
            runAsNonRoot: false
            allowPrivilegeEscalation: false
            capabilities:
              add: ["CHOWN"]
              drop: ["ALL"]
          volumeMounts:
            - name: deps-cache
              mountPath: /deps-cache
        {{- end }}
        {{- if $root.Values.netinit.enabled }}
        - name: setup-netpol
          image: "{{ $root.Values.netinit.image }}:{{ $root.Values.netinit.tag }}"
          imagePullPolicy: {{ $root.Values.netinit.pullPolicy }}
          command:
            - sh
            - -c
            - |
              set -eu
              # Flush so a same-netns re-run doesn't accumulate dup rules.
              iptables -F OUTPUT
              iptables -A OUTPUT -o lo -j ACCEPT
              # Allow return traffic for connections initiated INTO the pod
              # (e.g. preview gateway → daemon:9000). Without this rule the
              # OUTPUT chain REJECTs SYN-ACK responses back to the gateway
              # pod IP — gateway pod IPs sit in RFC1918, which the blockCIDRs
              # rules below REJECT. Symptom: Envoy "upstream connect error /
              # connection timeout" on every preview request.
              # Try -m conntrack, fall back to legacy -m state. If neither
              # is available (full-eBPF nodes without nf_conntrack) we
              # fail-closed: preview ingress is a load-bearing feature,
              # silently degrading it is not acceptable. Operator must run
              # this chart on a node that supports stateful filtering.
              iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
                || iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
                || { echo "ERROR: neither -m conntrack nor -m state available; cannot install ESTABLISHED,RELATED rule. Preview ingress would silently break. Failing the init container so the pod does not come up." >&2; exit 1; }
              {{- if $root.Values.telemetry.enabled }}
              # The ONE in-cluster destination a sandbox may reach: the OTLP
              # collector. Must precede the blockCIDR REJECTs below — the
              # collector's ClusterIP lives inside them (172.20.x is covered by
              # 172.16.0.0/12), so a rule placed after would never be evaluated.
              # Scoped to an exact /32 and a single port: this is a hole in the
              # boundary that keeps user code away from in-cluster services, and
              # it stays exactly one destination wide.
              iptables -A OUTPUT -d {{ printf "%s/32" $root.Values.telemetry.otlp.ip | quote }} -p tcp --dport {{ $root.Values.telemetry.otlp.port }} -j ACCEPT
              {{- end }}
              {{- range $root.Values.netinit.blockCIDRs }}
              iptables -A OUTPUT -d {{ . | quote }} -j REJECT
              {{- end }}
              {{- range $root.Values.netinit.allowedUDPPorts }}
              iptables -A OUTPUT -p udp --dport {{ . }} -j ACCEPT
              {{- end }}
              {{- range $root.Values.netinit.allowedTCPPorts }}
              iptables -A OUTPUT -p tcp --dport {{ . }} -j ACCEPT
              {{- end }}
              iptables -A OUTPUT -j REJECT
              # Skip IPv6 cleanly on kernels without ip6_tables.
              if ip6tables -L > /dev/null 2>&1; then
                ip6tables -F OUTPUT
                ip6tables -A OUTPUT -o lo -j ACCEPT
                # Same ESTABLISHED,RELATED rule for IPv6 — see IPv4 block
                # above. Fail-closed for the same reason.
                ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
                  || ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
                  || { echo "ERROR: neither -m conntrack nor -m state available (ip6tables); cannot install ESTABLISHED,RELATED rule for IPv6. Failing the init container." >&2; exit 1; }
                {{- range $root.Values.netinit.blockCIDRsIPv6 }}
                ip6tables -A OUTPUT -d {{ . | quote }} -j REJECT
                {{- end }}
                {{- range $root.Values.netinit.allowedUDPPorts }}
                ip6tables -A OUTPUT -p udp --dport {{ . }} -j ACCEPT
                {{- end }}
                {{- range $root.Values.netinit.allowedTCPPorts }}
                ip6tables -A OUTPUT -p tcp --dport {{ . }} -j ACCEPT
                {{- end }}
                ip6tables -A OUTPUT -j REJECT
              fi
              # Dump rules so `kubectl logs -c setup-netpol` shows the policy.
              echo "=== final IPv4 OUTPUT ==="
              iptables -L OUTPUT -n -v --line-numbers
              if ip6tables -L > /dev/null 2>&1; then
                echo "=== final IPv6 OUTPUT ==="
                ip6tables -L OUTPUT -n -v --line-numbers
              fi
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 64Mi
          securityContext:
            capabilities:
              add: ["NET_ADMIN"]
              drop: ["ALL"]
            runAsUser: 0
            runAsNonRoot: false
            allowPrivilegeEscalation: false
        {{- end }}
      {{- end }}
      containers:
        - name: sandbox
          image: "{{ include "sandbox-env.sandboxImage" $root }}"
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          workingDir: /app
          env:
            - name: WORKDIR
              value: "/app"
            {{- if $root.Values.depsCache.enabled }}
            # Root of the node-local dependency cache; the daemon derives a
            # per-repo BUN_INSTALL_CACHE_DIR under it (see setup/install.ts).
            - name: DEPS_CACHE_ROOT
              value: "/deps-cache"
            {{- if $root.Values.depsCache.golden }}
            # Golden node_modules reflink cache (opt-in, off by default — it
            # touches the boot install path). Requires a reflink-capable
            # filesystem shared between the cache and the workdir; falls back
            # to a normal install otherwise. See setup/golden-cache.ts.
            - name: GOLDEN_CACHE_ENABLED
              value: "1"
            {{- end }}
            {{- if $root.Values.depsCache.remote.enabled }}
            # L2 shared archive store (read-only mount below). Absent →
            # daemon is L1-only, i.e. today's behavior. Deliberately NOT nested
            # under `golden`: the volume below is mounted whenever
            # `remote.enabled` is set, so gating only the env var here would
            # mount an RWX PVC into every sandbox pod that the daemon then
            # never reads. L2 restore does not need L1 enabled (it only seeds
            # L1 opportunistically, which is a no-op when golden is off).
            - name: GOLDEN_CACHE_REMOTE
              value: {{ $root.Values.depsCache.remote.mountPath | quote }}
            # Stamped onto every golden this pod publishes, so the node-level
            # uploader can tell which environment produced it. Nodes are shared
            # across environments; the golden path is not environment-scoped.
            - name: SANDBOX_ENV
              value: {{ include "sandbox-env.envName" $root | quote }}
            {{- end }}
            {{- end }}
            {{- if $root.Values.telemetry.enabled }}
            # OTLP metrics endpoint for the daemon. Standard OTel variable, so
            # it reaches whichever daemon the image runs — a daemon with no
            # exporter wired simply ignores it. Absent → the daemon must not
            # start an exporter at all (no endpoint is the off switch).
            #
            # An IP, never a DNS name: sandboxes run `dnsPolicy: None` against
            # public resolvers, so `gateway-otlp.opentelemetry-collector` is
            # NXDOMAIN in here. Same value drives the netinit ACCEPT above, so
            # the reachable destination and the configured one cannot drift.
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: {{ include "sandbox-env.otlpEndpoint" $root | quote }}
            {{- end }}
            - name: DAEMON_PORT
              value: "9000"
            - name: DAEMON_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ include "sandbox-env.sentinelSecretName" $root }}
                  key: daemonToken
            {{- if $root.Values.readOnlyRootFilesystem }}
            # With RO rootfs + emptyDir on /app, the mount root is owned
            # root:1000 (fsGroup). Git 2.35+'s "dubious ownership" check
            # would refuse to operate. Disable the check inside the
            # sandbox — single-tenant pod, no untrusted same-pod user.
            - name: GIT_CONFIG_COUNT
              value: "1"
            - name: GIT_CONFIG_KEY_0
              value: "safe.directory"
            - name: GIT_CONFIG_VALUE_0
              value: "*"
            {{- end }}
            {{- if not $root.Values.disableFsSidecar }}
            # org-fs relay: the daemon writes the mount config here for the
            # sidecar, and gates the per-run output link on its status file.
            - name: ORGFS_SIDECAR_CONFIG_PATH
              value: "/run/orgfs/config.json"
            - name: ORGFS_SIDECAR_STATUS_PATH
              value: "/run/orgfs/status.json"
            {{- end }}
          ports:
            - name: daemon
              containerPort: 9000
              protocol: TCP
            - name: dev
              containerPort: 3000
              protocol: TCP
          resources:
            {{- toYaml (default $root.Values.resources $pool.resources) | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            readOnlyRootFilesystem: {{ $root.Values.readOnlyRootFilesystem }}
          volumeMounts:
            {{- if $root.Values.readOnlyRootFilesystem }}
            - name: workdir
              mountPath: /app
            - name: tmp
              mountPath: /tmp
            {{- end }}
            {{- if $root.Values.depsCache.enabled }}
            - name: deps-cache
              mountPath: /deps-cache
            {{- if $root.Values.depsCache.remote.enabled }}
            # readOnly is the load-bearing control, not a hint: this pod runs
            # untrusted code and bun installs cached content as-is, so write
            # access here would let one tenant poison another repo's archive
            # fleet-wide. Publishing belongs to a trusted writer.
            - name: golden-remote
              mountPath: {{ $root.Values.depsCache.remote.mountPath }}
              readOnly: true
            {{- end }}
            {{- end }}
            - name: home
              mountPath: /home/sandbox
            {{- if not $root.Values.disableFsSidecar }}
            # The sidecar's FUSE mounts under /app/org surface here.
            - name: orgfs-org
              mountPath: /app/org
              mountPropagation: HostToContainer
            - name: orgfs-ctl
              mountPath: /run/orgfs
            {{- end }}
        {{- if not $root.Values.disableFsSidecar }}
        # Privileged org-fs mounter: waits for the daemon to relay the mount
        # config onto /run/orgfs (post-bind push), FUSE-mounts the org volumes
        # under the shared /app/org, and Bidirectional propagation surfaces
        # them in the (unprivileged) sandbox container. See
        # packages/sandbox/orgfs/sidecar.ts.
        - name: orgfs-sidecar
          image: "{{ $root.Values.orgFs.image.repository }}:{{ $root.Values.orgFs.image.tag }}"
          imagePullPolicy: {{ $root.Values.orgFs.image.pullPolicy }}
          env:
            - name: APP_ROOT
              value: "/app"
          securityContext:
            # FUSE mount + Bidirectional propagation require privileged; root
            # uid adds nothing on top of that, so keep it simple for fuse.
            privileged: true
            runAsUser: 0
            runAsNonRoot: false
          resources:
            {{- toYaml $root.Values.orgFs.resources | nindent 12 }}
          volumeMounts:
            - name: orgfs-org
              mountPath: /app/org
              mountPropagation: Bidirectional
            - name: orgfs-ctl
              mountPath: /run/orgfs
        {{- end }}
      volumes:
        {{- if $root.Values.readOnlyRootFilesystem }}
        # Sized to match the per-container ephemeral-storage limit shape;
        # individual mounts get a slice. Adjust if a workload needs more.
        - name: workdir
          emptyDir:
            sizeLimit: 4Gi
        - name: tmp
          emptyDir:
            sizeLimit: 1Gi
        {{- end }}
        - name: home
          emptyDir:
            sizeLimit: 5Gi
        {{- if $root.Values.depsCache.enabled }}
        # Node-local package cache shared across sandbox pods (see the
        # depsCache comment in values.yaml for the hardlink + isolation
        # rationale).
        - name: deps-cache
          hostPath:
            path: {{ $root.Values.depsCache.hostPath }}
            type: DirectoryOrCreate
        {{- if $root.Values.depsCache.remote.enabled }}
        - name: golden-remote
          persistentVolumeClaim:
            claimName: {{ include "sandbox-env.goldenRemoteClaimName" $root }}
            readOnly: true
        {{- end }}
        {{- end }}
        {{- if not $root.Values.disableFsSidecar }}
        # Mount surface (volumes attach under it) + relay control files.
        - name: orgfs-org
          emptyDir:
            sizeLimit: 1Gi
        - name: orgfs-ctl
          emptyDir:
            sizeLimit: 1Mi
        {{- end }}
{{- end }}
