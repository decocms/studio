# sandbox-operator Helm chart

Pure packaging of the upstream
[`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox)
operator + CRDs (vendored — upstream does not publish a Helm chart as of
v0.4.2). Installs:

- `Namespace` `agent-sandbox-system` (with PodSecurity admission labels)
- `ServiceAccount`, `Service`, `Deployment` for the controller
- `ClusterRole` + `ClusterRoleBinding` for the base + extensions reconcilers
- All `CustomResourceDefinition`s the operator owns

This chart **deliberately exposes no tunables**. Studio-side resources
(`SandboxTemplate`, RBAC for the mesh runner, `NetworkPolicy`,
`SandboxWarmPool`, preview `Gateway`/`HTTPRoute`/`Certificate`) live in the
companion [`sandbox-env`](../sandbox-env/) chart and are installed once per
environment alongside this one.

Pinned upstream version: **v0.4.2** (see `Chart.yaml` `appVersion`).

## Prerequisites

- **Kubernetes 1.30+** (enforced by `Chart.yaml` `kubeVersion`).
- The chart **must be installed into the `agent-sandbox-system` namespace**.
  The vendored upstream operator manifest hardcodes that namespace; `helm
  template` will fail otherwise. See the validation in `_helpers.tpl`.

## Install

Published as an OCI artifact at
`oci://ghcr.io/decocms/studio/charts/sandbox-operator` by
`.github/workflows/release-sandbox-charts.yaml`.

```bash
helm install sandbox-operator \
  oci://ghcr.io/decocms/studio/charts/sandbox-operator \
  --version 0.1.0 \
  --namespace agent-sandbox-system --create-namespace
```

Then install one `sandbox-env` release per environment that needs to use
this operator. See [`../sandbox-env/README.md`](../sandbox-env/README.md).

### ArgoCD Application

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: sandbox-operator
  namespace: argocd
spec:
  project: default
  source:
    repoURL: ghcr.io/decocms/studio/charts
    chart: sandbox-operator
    targetRevision: 0.1.0
  destination:
    server: https://kubernetes.default.svc
    namespace: agent-sandbox-system
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

## Layout

```
sandbox-operator/
├── Chart.yaml
├── values.yaml                     # intentionally empty
├── vendor.sh                       # re-fetches upstream YAML
├── crds/
│   └── agent-sandbox-crds.yaml     # vendored CRDs
└── templates/
    ├── _helpers.tpl
    ├── validations.yaml            # namespace preflight
    └── agent-sandbox-manifest.yaml # vendored upstream operator
```

`vendor.sh` splits upstream multi-doc YAML on `kind: CustomResourceDefinition`
boundaries and routes each doc into `crds/` or `templates/`.

## CRD upgrade caveat

Helm install-applies files under `crds/` on first install but **never
upgrades them** (intentional Helm design choice). After bumping `appVersion`
via `./vendor.sh`, run:

```bash
kubectl apply -f deploy/helm/sandbox-operator/crds/agent-sandbox-crds.yaml
# then helm upgrade as normal
```

Uninstall + reinstall also works but drops existing `SandboxClaim`s.

## Bumping upstream version

```bash
./vendor.sh v0.4.3               # re-fetches + re-splits, requires sha256 in KNOWN_CHECKSUMS
# edit Chart.yaml: appVersion -> "0.4.3"
# bump version: 0.1.0 -> 0.2.0
```

Push to `main` — `release-sandbox-charts.yaml` packages and pushes the new
OCI tag to `ghcr.io`. Argo CD picks it up by the `targetRevision` in the
`Application` manifest.

Check upstream release notes for CRD schema changes — if `sandboxtemplates`
or `sandboxwarmpools` shape changes, the matching templates in `sandbox-env`
may need corresponding edits.

## Why not an upstream Helm chart?

Upstream hasn't published one as of v0.4.2. Filing a request with prior art
pointing at this chart is worthwhile — if upstream ships an official chart,
the vendored copy goes away and this chart switches to a `dependencies:`
entry pointing at upstream's repo.
